import {
  MASKED_VALUE,
  type AuthConfig,
  type ExecuteInput,
  type ExecuteResult,
  type ExecuteTimings,
  type KeyValueItem,
  type ScriptLogEntry,
  type ScriptTestResult,
} from '@reqster/shared';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { request as undiciRequest } from 'undici';
import { getFolderChainLeafToRoot, resolveEffectiveAuth } from '../core/hierarchy.js';
import { buildResolver, collectSecretValues } from '../core/variables/resolve.js';
import { getCollection } from '../db/repositories/collections.js';
import { insertHistory, pruneHistory } from '../db/repositories/history.js';
import { getRequest } from '../db/repositories/requests.js';
import { getSetting } from '../db/repositories/settings.js';
import { getDefaultWorkspace } from '../db/repositories/workspaces.js';
import { msg } from '../i18n/context.js';
import { contentTypeOf, decodeBody, isBinaryBody } from './bodyDecode.js';
import { ResponseFileWriter, type StoredResponse, suggestFileName } from './responseStore.js';
import { createContext, interpolate, maskSecrets } from './interpolate.js';
import { createDispatcherFor, describeProxyError, isStaleSocketError, sendWithStaleRetry } from './dispatcher.js';
import { flattenHeaders } from './scriptHttp.js';
import { runScriptChain, type ScriptChainStep } from './scriptRunner.js';
import { now, TimingProbe } from './timing.js';

function enabledItems(items: KeyValueItem[]): KeyValueItem[] {
  return items.filter((i) => i.enabled && i.key.trim() !== '');
}

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

function hasScript(steps: ScriptChainStep[]): boolean {
  return steps.some((s) => s.script != null && s.script.trim() !== '');
}

export async function executeRequest(input: ExecuteInput, signal?: AbortSignal): Promise<ExecuteResult> {
  // Süre dökümü: hazırlık = toplam − scriptler − ağ; ağ adımları probe'dan
  const begin = now();
  const probe = new TimingProbe();
  const workspace = getDefaultWorkspace();

  // İstek/klasör/koleksiyon zincirini bir kez çöz; auth inheritance ve script
  // sıralaması aynı zinciri paylaşır (TASARIM.md §4.1, §5.3).
  let folderId: string | null | undefined = input.folderId;
  if (input.requestId) {
    const saved = getRequest(input.requestId);
    if (saved) folderId = saved.folderId;
  }
  const folderChainLeafToRoot = getFolderChainLeafToRoot(folderId);
  const collection = input.collectionId ? getCollection(input.collectionId) : null;

  const scriptLogs: ScriptLogEntry[] = [];
  const testResults: ScriptTestResult[] = [];

  // --- Pre-request script zinciri: koleksiyon → klasör(ler, kökten yaprağa) → istek ---
  // `source` UI'daki Console/Tests panelinde görünür; istek dilinde üretilir
  const collectionSource = collection
    ? msg('execute.sourceCollection', { name: collection.name })
    : msg('execute.sourceCollectionUnnamed');
  const folderSource = (name: string) => msg('execute.sourceFolder', { name });
  const requestSource = msg('execute.sourceRequest');
  const preSteps: ScriptChainStep[] = [
    { script: collection?.preRequestScript ?? null, source: collectionSource },
    ...[...folderChainLeafToRoot].reverse().map((f) => ({ script: f.preRequestScript, source: folderSource(f.name) })),
    { script: input.preRequestScript ?? null, source: requestSource },
  ];

  const preStart = now();
  const preOutcome = await runScriptChain(
    preSteps,
    'pre-request',
    {
      method: input.method,
      url: input.url,
      headers: input.headers,
      params: input.params,
      body: input.body,
    },
    undefined,
    { workspaceId: workspace.id, collectionId: input.collectionId, requestId: input.requestId },
    signal,
  );
  const preScriptMs = hasScript(preSteps) ? now() - preStart : null;
  scriptLogs.push(...preOutcome.logs);
  testResults.push(...preOutcome.tests);

  // İstek gönderilmeden biten yürütmenin dökümü: yalnızca hazırlık + pre-request script
  const earlyTimings = () => {
    const totalMs = now() - begin;
    return probe.build({
      prepareMs: totalMs - (preScriptMs ?? 0),
      preScriptMs,
      postScriptMs: null,
      totalMs,
      redirects: 0,
      proxied: false,
    });
  };

  if (preOutcome.fatalError) {
    return failResult(
      msg('execute.preRequestError', { error: preOutcome.fatalError }),
      input,
      input.url,
      new Set(),
      scriptLogs,
      testResults,
      earlyTimings(),
    );
  }

  // Pre-request script sürerken iptal edildiyse (script durdurulur) istek hiç gönderilmez
  if (signal?.aborted || preOutcome.cancelled) {
    return failResult(msg('execute.cancelled'), input, input.url, new Set(), scriptLogs, testResults, earlyTimings());
  }

  // Script'lerin mutasyona uğrattığı istek; bundan sonraki tüm akış buna göre işler
  const liveRequest = preOutcome.requestSnapshot;

  // Değişken çözümleyici pre-request script'lerden SONRA, taze DB durumuna göre kurulur
  const resolver = buildResolver(workspace.id, input.collectionId);
  const ctx = createContext(resolver);

  // --- İstek bileşenlerini interpolasyonla çöz ---
  const rawUrl = interpolate(liveRequest.url.trim(), ctx);
  const headers = new Map<string, string>();
  for (const h of enabledItems(liveRequest.headers)) {
    headers.set(interpolate(h.key, ctx), interpolate(h.value, ctx));
  }

  const auth = resolveEffectiveAuth(input.auth, folderChainLeafToRoot, collection);
  const extraQuery: Array<[string, string]> = [];
  if (auth) applyAuth(auth, headers, extraQuery, ctx);

  // --- URL + query paramları ---
  let url: URL;
  try {
    url = new URL(rawUrl.includes('://') ? rawUrl : `http://${rawUrl}`);
  } catch {
    return failResult(
      msg('execute.invalidUrl', { url: rawUrl }),
      input,
      rawUrl,
      ctx.unresolved,
      scriptLogs,
      testResults,
      earlyTimings(),
    );
  }
  for (const p of enabledItems(liveRequest.params)) {
    url.searchParams.append(interpolate(p.key, ctx), interpolate(p.value, ctx));
  }
  for (const [k, v] of extraQuery) url.searchParams.append(k, v);

  // --- Body ---
  let bodyPayload: string | Buffer | undefined;
  /** Geçmişe yazılacak metin biçimi (dosya içeriği yerine yer tutucu) */
  let historyBody: string | undefined;
  const body = liveRequest.body;
  if (body && input.method !== 'GET' && input.method !== 'HEAD') {
    if (body.mode === 'raw' && body.raw != null) {
      bodyPayload = interpolate(body.raw, ctx);
      if (body.contentType && !hasHeader(headers, 'content-type')) {
        headers.set('Content-Type', body.contentType);
      }
    } else if (body.mode === 'urlencoded') {
      const form = new URLSearchParams();
      for (const item of enabledItems(body.items ?? [])) {
        form.append(interpolate(item.key, ctx), interpolate(item.value, ctx));
      }
      bodyPayload = form.toString();
      if (!hasHeader(headers, 'content-type')) {
        headers.set('Content-Type', 'application/x-www-form-urlencoded');
      }
    } else if (body.mode === 'form-data') {
      const boundary = `----reqster${Date.now().toString(16)}`;
      const chunks: Buffer[] = [];
      const display: string[] = [];
      const quote = (s: string) => s.replace(/\r|\n/g, ' ').replace(/"/g, '%22');
      // Dosya alanı yalnızca kullanıcının verdiği istekte aynen varsa okunur: pre-request script'i rq.request.body
      // üzerinden dosya satırı ekleyip ya da yolunu değiştirip diskteki bir dosyayı dışarı gönderemesin (sandbox
      // dosya erişimsizdir). Aynı nedenle yol {{değişken}} ile çözülmez; script değişkenleri değiştirebilir.
      const userFilePaths = new Set(
        (input.body?.mode === 'form-data' ? enabledItems(input.body.items ?? []) : [])
          .filter((i) => i.type === 'file')
          .map((i) => i.value),
      );
      for (const item of enabledItems(body.items ?? [])) {
        const name = quote(interpolate(item.key, ctx));
        if (item.type === 'file') {
          if (!userFilePaths.has(item.value)) {
            return failResult(
              msg('execute.formFileFromScript', { key: name }),
              input,
              url.toString(),
              ctx.unresolved,
              scriptLogs,
              testResults,
              earlyTimings(),
            );
          }
          // Dosya yürütme anında diskten okunur; geçmişe içerik değil yalnızca ad/boyut yazılır
          const filePath = item.value.trim();
          let data: Buffer;
          try {
            data = await readFile(filePath);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return failResult(
              msg('execute.formFileUnreadable', { key: name, path: filePath, error: reason }),
              input,
              url.toString(),
              ctx.unresolved,
              scriptLogs,
              testResults,
              earlyTimings(),
            );
          }
          const head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${quote(basename(filePath))}"\r\nContent-Type: ${mimeFor(filePath)}\r\n\r\n`;
          chunks.push(Buffer.from(head), data, Buffer.from('\r\n'));
          display.push(`${head}<${basename(filePath)}: ${data.length} B>\r\n`);
        } else {
          const part = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${interpolate(item.value, ctx)}\r\n`;
          chunks.push(Buffer.from(part));
          display.push(part);
        }
      }
      const tail = `--${boundary}--\r\n`;
      chunks.push(Buffer.from(tail));
      display.push(tail);
      bodyPayload = Buffer.concat(chunks);
      historyBody = display.join('');
      headers.set('Content-Type', `multipart/form-data; boundary=${boundary}`);
    }
  }

  // --- Gönderim ---
  const timeoutMs = getSetting('network.timeout_ms');
  const maxRedirects = getSetting('network.max_redirects');
  const maxBodyBytes = getSetting('history.max_body_bytes');
  // Kapalıyken self-signed/kurum CA'lı sunuculara istek atılabilir; sonuçta tlsVerified=false döner (TASARIM.md §8)
  const verifyTls = getSetting('network.verify_tls');
  const secretValues = collectSecretValues(resolver, ctx.usedKeys);
  const startedAt = Date.now();

  let status: number | undefined;
  let responseHeaders: Array<[string, string]> = [];
  let responseBody = '';
  let charset: string | undefined;
  let sizeBytes = 0;
  let truncated = false;
  let binary = false;
  let bodyFile: StoredResponse | undefined;
  let errorMessage: string | undefined;
  let redirects = 0;

  // Aktif proxy varsa ve hedef atlama listesinde değilse istek proxy'den gider (sonuçta viaProxy döner).
  // Paylaşılan keep-alive havuzu: ardışık isteklerde DNS/TCP/TLS tekrarlanmaz.
  const { dispatcher, proxyName, proxyHost, release } = createDispatcherFor(url, {
    timeoutMs,
    maxRedirects,
    verifyTls,
    shared: true,
  });

  try {
    probe.sendStart = now();
    const res = await sendWithStaleRetry(input.method, probe, () =>
      undiciRequest(url, {
        method: input.method,
        headers: Object.fromEntries(headers),
        body: bodyPayload,
        dispatcher,
        signal,
      }),
    );
    probe.headersAt = now();
    // Yönlendirme interceptor'ı gidilen adresleri (ilki dahil) context.history'ye yazar
    const history = (res.context as { history?: unknown[] } | undefined)?.history;
    redirects = Array.isArray(history) ? Math.max(0, history.length - 1) : 0;
    status = res.statusCode;
    responseHeaders = flattenHeaders(res.headers);

    // Arayüze/history'ye giden gövde ilk `maxBodyBytes` ile sınırlıdır; tamamı "Yanıtı kaydet" için diske akar
    const chunks: Buffer[] = [];
    const file = new ResponseFileWriter();
    try {
      for await (const chunk of res.body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        sizeBytes += buf.length;
        if (!truncated) {
          chunks.push(buf);
          if (sizeBytes > maxBodyBytes) truncated = true;
        }
        await file.write(buf);
      }
    } catch (err) {
      await file.discard();
      throw err;
    }
    probe.endAt = now();
    bodyFile = await file.finish(suggestFileName(responseHeaders, url));
    const head = Buffer.concat(chunks).subarray(0, maxBodyBytes);
    const contentType = contentTypeOf(responseHeaders);
    if (isBinaryBody(head, contentType)) {
      // İkili içerik metne çevrilmez (geri dönüşsüz bozulur); arayüz kart gösterir, scriptler boş gövde görür
      binary = true;
      truncated = false;
    } else {
      const decoded = decodeBody(head, contentType, truncated);
      responseBody = decoded.text;
      charset = decoded.charset;
    }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    errorMessage = signal?.aborted
      ? msg('execute.cancelled')
      : (proxyHost ? describeProxyError(err, proxyHost) : undefined) ??
      // Havuzdan gelen bağlantı yanıtsız kapandı ve istek idempotent olmadığı için yinelenmedi
      (probe.headersAt == null && !probe.openedConnection && !probe.retried && isStaleSocketError(err)
        ? msg('execute.staleConnection', { error: raw, method: input.method })
        : raw);
  } finally {
    release();
  }

  const durationMs = Date.now() - startedAt;
  const networkEnd = now();
  let postScriptMs: number | null = null;

  // --- Post-response script zinciri: istek → klasör(ler, yapraktan köke) → koleksiyon ---
  if (!errorMessage) {
    const postSteps: ScriptChainStep[] = [
      { script: input.postResponseScript ?? null, source: requestSource },
      ...folderChainLeafToRoot.map((f) => ({ script: f.postResponseScript, source: folderSource(f.name) })),
      { script: collection?.postResponseScript ?? null, source: collectionSource },
    ];
    const postStart = now();
    const postOutcome = await runScriptChain(
      postSteps,
      'post-response',
      liveRequest,
      { status: status ?? null, headers: responseHeaders, body: responseBody, durationMs },
      { workspaceId: workspace.id, collectionId: input.collectionId, requestId: input.requestId },
      signal,
    );
    if (hasScript(postSteps)) postScriptMs = now() - postStart;
    scriptLogs.push(...postOutcome.logs);
    testResults.push(...postOutcome.tests);
    if (postOutcome.cancelled) {
      scriptLogs.push({ level: 'warn', source: 'Post-response', message: msg('execute.cancelled') });
    } else if (postOutcome.fatalError) {
      scriptLogs.push({ level: 'error', source: 'Post-response', message: postOutcome.fatalError });
    }
  }

  const totalMs = now() - begin;
  const timings = probe.build({
    // Ağ (gönderimden son bayta ya da hataya) ve scriptler dışında kalan her şey
    prepareMs: totalMs - (preScriptMs ?? 0) - (postScriptMs ?? 0) - (networkEnd - (probe.sendStart ?? networkEnd)),
    preScriptMs,
    postScriptMs,
    totalMs,
    redirects,
    proxied: proxyName != null,
  });

  // --- History snapshot (secret'lar maskelenir) ---
  const mask = (s: string) => maskSecrets(s, secretValues, MASKED_VALUE);
  const historyId = insertHistory({
    workspaceId: workspace.id,
    requestId: input.requestId ?? null,
    executedAt: startedAt,
    durationMs,
    method: input.method,
    url: mask(url.toString()),
    requestHeaders: [...headers.entries()].map(([k, v]): [string, string] => [k, mask(v)]),
    requestBody: bodyPayload != null ? mask(historyBody ?? (bodyPayload as string)) : null,
    statusCode: status ?? null,
    responseHeaders,
    // İkili gövde history'ye yazılmaz; yerine türünü ve boyutunu anlatan kısa bir not düşülür
    responseBody: errorMessage
      ? null
      : binary
        ? `<${contentTypeOf(responseHeaders)?.split(';')[0]?.trim() || 'binary'}: ${sizeBytes} B>`
        : mask(responseBody),
    responseSize: errorMessage ? null : sizeBytes,
    truncated,
    error: errorMessage ?? null,
    timings,
  });
  pruneHistory(workspace.id, getSetting('history.max_entries'));

  return {
    historyId,
    status,
    statusText: status != null ? String(status) : undefined,
    headers: responseHeaders,
    body: responseBody,
    sizeBytes,
    durationMs,
    truncated,
    ...(charset && charset !== 'utf-8' ? { charset } : {}),
    ...(binary ? { binary: true } : {}),
    ...(bodyFile && !errorMessage
      ? { bodyFile: { id: bodyFile.id, fileName: bodyFile.fileName, sizeBytes: bodyFile.sizeBytes, complete: bodyFile.complete } }
      : {}),
    error: errorMessage,
    resolvedUrl: url.toString(),
    unresolvedVariables: [...ctx.unresolved],
    scriptLogs,
    testResults,
    ...(verifyTls ? {} : { tlsVerified: false }),
    ...(proxyName ? { viaProxy: proxyName } : {}),
    timings,
  };
}

function applyAuth(
  auth: AuthConfig,
  headers: Map<string, string>,
  extraQuery: Array<[string, string]>,
  ctx: ReturnType<typeof createContext>,
): void {
  switch (auth.type) {
    case 'bearer':
      if (auth.bearer) {
        headers.set('Authorization', `Bearer ${interpolate(auth.bearer.token, ctx)}`);
      }
      break;
    case 'basic':
      if (auth.basic) {
        const raw = `${interpolate(auth.basic.username, ctx)}:${interpolate(auth.basic.password, ctx)}`;
        headers.set('Authorization', `Basic ${Buffer.from(raw).toString('base64')}`);
      }
      break;
    case 'apikey':
      if (auth.apikey) {
        const key = interpolate(auth.apikey.key, ctx);
        const value = interpolate(auth.apikey.value, ctx);
        if (auth.apikey.in === 'query') extraQuery.push([key, value]);
        else headers.set(key, value);
      }
      break;
    case 'none':
      break;
  }
}

function hasHeader(headers: Map<string, string>, name: string): boolean {
  for (const key of headers.keys()) {
    if (key.toLowerCase() === name) return true;
  }
  return false;
}

function failResult(
  message: string,
  input: ExecuteInput,
  resolvedUrl: string,
  unresolved: Set<string>,
  scriptLogs: ScriptLogEntry[],
  testResults: ScriptTestResult[],
  timings: ExecuteTimings,
): ExecuteResult {
  const workspace = getDefaultWorkspace();
  const historyId = insertHistory({
    workspaceId: workspace.id,
    requestId: input.requestId ?? null,
    executedAt: Date.now(),
    durationMs: null,
    method: input.method,
    url: resolvedUrl,
    requestHeaders: [],
    requestBody: null,
    statusCode: null,
    responseHeaders: [],
    responseBody: null,
    responseSize: null,
    truncated: false,
    error: message,
    timings,
  });
  return {
    historyId,
    headers: [],
    body: '',
    sizeBytes: 0,
    durationMs: 0,
    truncated: false,
    error: message,
    resolvedUrl,
    unresolvedVariables: [...unresolved],
    scriptLogs,
    testResults,
    scriptError: message,
    timings,
  };
}
