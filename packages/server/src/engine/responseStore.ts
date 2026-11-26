import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { resolveDataDir } from '../db/connection.js';
import { newId } from '../db/ids.js';

/**
 * Yanıtların TAM gövdesi için geçici dosya deposu ("Yanıtı kaydet"). Arayüze ve history'ye giden gövde
 * `history.max_body_bytes` ile kırpılıp metne çevrilir; zip gibi ikili ya da büyük bir yanıtın aslı yalnızca
 * burada durur ve `GET /api/responses/:id/file` ile indirilir. İstek yeniden gönderilmez.
 *
 * Kalıcı değildir: dizin açılışta boşaltılır, her yeni yanıtta en eskiler silinir (en çok `MAX_FILES` dosya ve
 * `MAX_TOTAL_BYTES`; en yeni dosya her zaman kalır). Silinmiş dosyayı isteyen arayüz 404 alır ("yeniden gönderin").
 * Dosyalar yanıtı olduğu gibi içerir (secret maskelemesi yoktur); veri klasörünün dışına çıkmaz.
 */
export const RESPONSE_FILE_MAX_BYTES = 200 * 1024 * 1024;
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

export interface StoredResponse {
  id: string;
  path: string;
  fileName: string;
  sizeBytes: number;
  /** Yanıt `RESPONSE_FILE_MAX_BYTES`'ı aştıysa `false`: dosyada yalnızca baş kısım vardır */
  complete: boolean;
}

const stored = new Map<string, StoredResponse>();

function storeDir(): string {
  return path.join(resolveDataDir(), 'tmp', 'responses');
}

/** Açılışta: önceki oturumdan kalan dosyalar (çökme, zorla kapatma) temizlenir */
export function clearResponseFiles(): void {
  try {
    rmSync(storeDir(), { recursive: true, force: true });
  } catch {
    // silinemeyen dosya açılışı engellemez
  }
  stored.clear();
}

export function getStoredResponse(id: string): StoredResponse | undefined {
  return stored.get(id);
}

/** Yanıt gövdesini parça parça diske yazar; bellekte tutmaz, yavaş diskte akışı bekletir (backpressure) */
export class ResponseFileWriter {
  private readonly id = newId();
  private readonly filePath: string;
  private readonly stream: WriteStream;
  private written = 0;
  private overflowed = false;
  private failed = false;

  constructor() {
    mkdirSync(storeDir(), { recursive: true });
    this.filePath = path.join(storeDir(), `${this.id}.bin`);
    this.stream = createWriteStream(this.filePath);
    // Disk dolu / izin hatası yanıtı düşürmesin: dosya kaydedilemez, yanıt yine gösterilir
    this.stream.on('error', () => {
      this.failed = true;
    });
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.failed || this.overflowed) return;
    const room = RESPONSE_FILE_MAX_BYTES - this.written;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length < chunk.length) this.overflowed = true;
    if (part.length === 0) return;
    this.written += part.length;
    if (!this.stream.write(part)) await Promise.race([once(this.stream, 'drain'), once(this.stream, 'close')]);
  }

  /** Dosyayı kapatıp kaydeder; boş gövdede ya da yazma hatasında dosya silinir ve `undefined` döner */
  async finish(fileName: string): Promise<StoredResponse | undefined> {
    await this.close();
    if (this.failed || this.written === 0) {
      remove(this.filePath);
      return undefined;
    }
    const entry: StoredResponse = {
      id: this.id,
      path: this.filePath,
      fileName,
      sizeBytes: this.written,
      complete: !this.overflowed,
    };
    stored.set(entry.id, entry);
    prune(entry.id);
    return entry;
  }

  /** İstek hata verdi / iptal edildi: yarım dosya bırakılmaz */
  async discard(): Promise<void> {
    await this.close();
    remove(this.filePath);
  }

  private async close(): Promise<void> {
    if (this.stream.closed) return;
    const closed = once(this.stream, 'close');
    this.stream.end();
    await closed.catch(() => undefined);
  }
}

/** Silinemeyen dosya (Windows'ta indirme sürerken kilitli) yanıtı düşürmez; açılıştaki temizlik alır */
function remove(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // bir sonraki budamada / açılışta yeniden denenir
  }
}

function prune(keepId: string): void {
  // Map ekleme sırasını korur: baştakiler en eski
  let total = 0;
  for (const e of stored.values()) total += e.sizeBytes;
  for (const e of [...stored.values()]) {
    if (stored.size <= MAX_FILES && total <= MAX_TOTAL_BYTES) break;
    if (e.id === keepId) continue;
    remove(e.path);
    stored.delete(e.id);
    total -= e.sizeBytes;
  }
  // Kayıt dışı kalmış dosya (beklenmez) birikmesin
  try {
    for (const name of readdirSync(storeDir())) {
      if (!stored.has(name.replace(/\.bin$/, ''))) {
        const p = path.join(storeDir(), name);
        if (Date.now() - statSync(p).mtimeMs > 60_000) remove(p);
      }
    }
  } catch {
    // dizin okunamıyorsa budama bir sonraki yanıta kalır
  }
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/msword': 'doc',
};

/**
 * Kaydedilecek dosyanın önerilen adı: yanıtın `Content-Disposition` başlığı → adresin son parçası → `response`.
 * Uzantı yoksa `Content-Type`'tan eklenir (bilinmiyorsa `.bin`). Yol ayırıcılar ve denetim karakterleri atılır;
 * ad yalnızca öneridir, dosyanın nereye yazılacağını kullanıcı (kaydet diyaloğu / tarayıcı) belirler.
 */
export function suggestFileName(headers: Array<[string, string]>, url: URL): string {
  const header = (name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1];
  const fromHeader = fileNameFromDisposition(header('content-disposition'));
  let name = sanitize(fromHeader ?? lastSegment(url));
  if (name === '') name = 'response';
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) {
    const type = (header('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    name += `.${EXTENSION_BY_TYPE[type] ?? (type.endsWith('+json') ? 'json' : type.endsWith('+xml') ? 'xml' : 'bin')}`;
  }
  return name;
}

function fileNameFromDisposition(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(value);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // bozuk kodlama: düz filename'e düş
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/.exec(value)?.[1]?.trim();
}

function lastSegment(url: URL): string {
  const segment = url.pathname.split('/').filter(Boolean).pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 150);
}
