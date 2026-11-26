import { newId } from '../db/ids.js';

/**
 * Masaüstü kabuğundan yerel dosya seçme diyaloğu isteme (form-data dosya alanı). Sayfa Tauri IPC kullanmaz ve
 * tarayıcı motoru seçilen dosyanın yolunu vermez; bu yüzden istek sidecar üzerinden geçer:
 *
 *   arayüz `POST /api/shell/pick-file` (yanıt bekler) → sunucu stdout'a `REQSTER_PICK_FILE <id>` yazar →
 *   kabuk yerel diyaloğu açar → kabuk `POST /api/internal/picked-file {id, path|null}` → bekleyen yanıt döner.
 *
 * İki kanal da (stdout satırı, token'lı yerel API) açılışta zaten kullanılan kanallardır. Aynı anda tek diyalog:
 * yeni istek bekleyeni iptal eder. Yol yalnızca kullanıcının seçtiği dosyadır; sunucu dosyayı burada okumaz.
 */
export const PICK_FILE_PREFIX = 'REQSTER_PICK_FILE ';
/** Kullanıcı diyaloğu açık bırakırsa bekleyen istek bu kadar sonra iptal sayılır */
const PICK_TIMEOUT_MS = 10 * 60_000;

let pending: { id: string; resolve: (path: string | null) => void; timer: NodeJS.Timeout } | null = null;

export function isDesktopSidecar(): boolean {
  return process.env.REQSTER_SIDECAR === '1';
}

/** Kabuğa diyalog açtırır; seçilen yol, iptalde / zaman aşımında `null` */
export function requestFilePick(): Promise<string | null> {
  settle(null);
  return new Promise((resolve) => {
    const id = newId();
    const timer = setTimeout(() => settle(null), PICK_TIMEOUT_MS);
    timer.unref();
    pending = { id, resolve, timer };
    process.stdout.write(`${PICK_FILE_PREFIX}${id}\n`);
  });
}

/** Kabuğun yanıtı; `id` bekleyen istekle eşleşmiyorsa (iptal edilmiş, eski) yok sayılır */
export function completeFilePick(id: string, path: string | null): boolean {
  if (pending?.id !== id) return false;
  settle(path);
  return true;
}

function settle(path: string | null): void {
  if (!pending) return;
  const { resolve, timer } = pending;
  pending = null;
  clearTimeout(timer);
  resolve(path);
}
