import { type Dispatcher, request as undiciRequest } from 'undici';
import { getSetting } from '../db/repositories/settings.js';
import { msg } from '../i18n/context.js';
import { SCRIPT_HTTP_MAX_BODY_BYTES, type ScriptHttpRequest, type ScriptHttpResponse } from '../scripting/protocol.js';
import { contentTypeOf, decodeBody } from './bodyDecode.js';
import { createDispatcherFor, describeProxyError, sendWithStaleRetry } from './dispatcher.js';
import { TimingProbe } from './timing.js';

/**
 * rq.sendRequest'in host tarafı: worker'dan IPC ile gelen (isolate'ta {{var}} çözümü yapılmış) isteği
 * undici ile gönderir. Zaman aşımı = min(network.timeout_ms, kalan script süresi) — ayar 0 (sınırsız) ise
 * yalnızca kalan script süresi; gövde 1 MB'ta kırpılır.
 * Bu istekler history'ye YAZILMAZ ve hiçbir yerde loglanmaz (secret maskeleme ilkesi: değer hiçbir
 * kalıcı yere girmez). Ağ hataları istek dilinde mesajlı Error olarak fırlatılır; worker bunu callback'in
 * `err` parametresine taşır.
 */
export async function sendScriptHttpRequest(
  request: ScriptHttpRequest,
  opts: { timeoutMs: number; signal: AbortSignal },
): Promise<ScriptHttpResponse> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw new Error(msg('sendRequest.invalidUrl', { url: request.url }));
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(msg('sendRequest.schemeUnsupported', { protocol: url.protocol }));
  }

  // network.timeout_ms = 0 sınırsız demektir; o zaman tek sınır script'in kalan süresidir
  const networkTimeoutMs = getSetting('network.timeout_ms');
  const timeoutMs = Math.max(1, networkTimeoutMs > 0 ? Math.min(networkTimeoutMs, opts.timeoutMs) : opts.timeoutMs);
  // Ana istekle aynı yol: aktif proxy varsa (ve hedef atlama listesinde değilse) buradan da proxy'den gider
  const { dispatcher, proxyHost, release } = createDispatcherFor(url, {
    timeoutMs,
    maxRedirects: getSetting('network.max_redirects'),
    verifyTls: getSetting('network.verify_tls'),
    // Ana istekle aynı keep-alive havuzu: token alıp aynı API'ye istek atan script'te el sıkışma bir kez olur
    shared: true,
  });
  // Header/body timeout'ları ara boşlukları ölçer; toplam süreyi (yavaş akan gövde dahil) sinyal keser
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]);
  const startedAt = Date.now();

  try {
    // Probe yalnızca "bağlantı havuzdan mı geldi" bilgisi için (bayat bağlantıda tek yineleme); süre dökümü yok
    const res = await sendWithStaleRetry(request.method, new TimingProbe(), () =>
      undiciRequest(url, {
        method: request.method as Dispatcher.HttpMethod,
        // undici dizi biçiminde düz [ad, değer, ad, değer] bekler; tekrar eden başlıklar korunur
        headers: request.headers.flat(),
        body: request.body ?? undefined,
        dispatcher,
        signal,
      }),
    );

    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (!truncated) {
        chunks.push(buf);
        if (size > SCRIPT_HTTP_MAX_BODY_BYTES) truncated = true;
      }
    }
    const headers = flattenHeaders(res.headers);
    return {
      status: res.statusCode,
      headers,
      body: decodeBody(Buffer.concat(chunks).subarray(0, SCRIPT_HTTP_MAX_BODY_BYTES), contentTypeOf(headers), truncated).text,
      truncated,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    throw new Error(describeNetworkError(err, url, timeoutMs, opts.signal.aborted, proxyHost));
  } finally {
    release();
  }
}

function describeNetworkError(
  err: unknown,
  url: URL,
  timeoutMs: number,
  runEnded: boolean,
  proxyHost: string | undefined,
): string {
  if (runEnded) return msg('sendRequest.runEnded');
  if (proxyHost) {
    const proxyMessage = describeProxyError(err, proxyHost);
    if (proxyMessage) return `rq.sendRequest: ${proxyMessage}`;
  }
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return msg('sendRequest.timeout', { ms: timeoutMs, host: url.host });
  }
  if (code === 'ECONNREFUSED') return msg('sendRequest.connectionRefused', { host: url.host });
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return msg('sendRequest.dnsFailed', { host: url.hostname });
  const detail = e?.cause?.message ?? e?.message ?? String(err);
  return msg('sendRequest.networkError', { host: url.host, detail });
}

/** undici'nin başlık nesnesini sıralı [ad, değer] listesine açar (çoklu değerler ayrı satır) */
export function flattenHeaders(headers: Record<string, string | string[] | undefined>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.push([key, v]);
    else out.push([key, value]);
  }
  return out;
}
