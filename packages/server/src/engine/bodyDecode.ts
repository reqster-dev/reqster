import { currentLang } from '../i18n/context.js';

export interface DecodedBody {
  text: string;
  /** Kullanılan kodlamanın WHATWG adı (`utf-8`, `windows-1254`…) */
  charset: string;
}

/** Bildirimi aramak için bakılan baş kısım (XML bildirimi / HTML `<meta>`) */
const SNIFF_BYTES = 1024;

function decoderFor(label: string | undefined, fatal = false): TextDecoder | null {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim(), { fatal });
  } catch {
    return null; // tanınmayan kodlama adı
  }
}

function bomCharset(buf: Buffer): string | undefined {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  return undefined;
}

/** `<?xml … encoding="…"?>` ya da `<meta charset=…>` / `<meta … content="…; charset=…">` */
function declaredInContent(buf: Buffer): string | undefined {
  const head = buf.subarray(0, SNIFF_BYTES).toString('latin1');
  const xml = /^\s*<\?xml[^>]*?encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  if (xml) return xml[1];
  const meta = /<meta[^>]*?charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return meta?.[1];
}

/**
 * Yanıt gövdesini metne çevirir. Kodlama sırası: BOM → `Content-Type` `charset` → içerikteki bildirim
 * (XML bildirimi, HTML meta) → UTF-8. Baytlar seçilen UTF-8'e uymuyorsa (kodlamasını bildirmeyen ya da
 * yanlış bildiren eski servisler) tarayıcılar gibi dile bağlı tek baytlık kodlamaya düşülür:
 * Türkçe arayüzde windows-1254, diğerinde windows-1252.
 */
export function decodeBody(buf: Buffer, contentType: string | undefined, truncated = false): DecodedBody {
  const fromHeader = /charset\s*=\s*["']?([^"';,\s]+)/i.exec(contentType ?? '')?.[1];
  const declared = decoderFor(bomCharset(buf)) ?? decoderFor(fromHeader) ?? decoderFor(declaredInContent(buf));
  if (declared && declared.encoding !== 'utf-8') {
    return { text: declared.decode(buf), charset: declared.encoding };
  }
  try {
    // Kırpılmış gövdenin sonundaki yarım kalmış çok baytlı karakter hata sayılmasın diye stream modu
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: truncated });
    return { text, charset: 'utf-8' };
  } catch {
    const fallback = new TextDecoder(currentLang() === 'tr' ? 'windows-1254' : 'windows-1252');
    return { text: fallback.decode(buf), charset: fallback.encoding };
  }
}

export function contentTypeOf(headers: Array<[string, string]>): string | undefined {
  return headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}
