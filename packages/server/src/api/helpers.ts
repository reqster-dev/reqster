import type { FastifyReply } from 'fastify';
import type { z } from 'zod';
import { msg } from '../i18n/context.js';
import { isMessageKey } from '../i18n/messages.js';

/**
 * Zod doğrulaması; hata halinde 400 döner ve null verir. Shared şemalar mesaj olarak sözlük
 * anahtarı taşır (`validation.urlRequired` gibi); anahtar olanlar istek diline çevrilir, zod'un
 * kendi varsayılan (İngilizce) mesajları olduğu gibi kalır.
 */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  body: unknown,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(body);
  if (!result.success) {
    reply.code(400).send({
      error: msg('validation.failed'),
      details: result.error.issues.map(
        (i) => `${i.path.join('.')}: ${isMessageKey(i.message) ? msg(i.message) : i.message}`,
      ),
    });
    return null;
  }
  return result.data;
}

/** Türkçe karakterleri ASCII'ye indirir, kalan özel karakterleri `_` yapar (RFC 6266 `filename` için) */
function asciiFileName(name: string): string {
  const transliterated = name
    .replace(/[çÇ]/g, (c) => (c === 'ç' ? 'c' : 'C'))
    .replace(/[ğĞ]/g, (c) => (c === 'ğ' ? 'g' : 'G'))
    .replace(/ı/g, 'i')
    .replace(/İ/g, 'I')
    .replace(/[öÖ]/g, (c) => (c === 'ö' ? 'o' : 'O'))
    .replace(/[şŞ]/g, (c) => (c === 'ş' ? 's' : 'S'))
    .replace(/[üÜ]/g, (c) => (c === 'ü' ? 'u' : 'U'))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  const safe = transliterated.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return safe === '' ? 'export' : safe;
}

/**
 * `Content-Disposition: attachment; filename="<ascii>"; filename*=UTF-8''<utf8>` değeri — tarayıcı UTF-8 adı
 * tercih eder. Uzantı (son noktadan sonrası) ASCII'ye indirgenirken korunur.
 */
export function attachmentHeader(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const [base, suffix] = dot > 0 ? [fileName.slice(0, dot), fileName.slice(dot)] : [fileName, ''];
  const ascii = `${asciiFileName(base)}${suffix.replace(/[^A-Za-z0-9.]+/g, '_')}`;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
