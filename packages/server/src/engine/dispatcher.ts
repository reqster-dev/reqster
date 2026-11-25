import { createHash } from 'node:crypto';
import { Agent, buildConnector, Client, type Dispatcher, interceptors, Pool, ProxyAgent } from 'undici';
import { getActiveProxy, type ActiveProxy } from '../db/repositories/proxies.js';
import { getSetting } from '../db/repositories/settings.js';
import { msg } from '../i18n/context.js';
import { probedConnector, type TimingProbe, withProbe } from './timing.js';
import { trustedCas } from './trustStore.js';

export interface DispatcherOptions {
  timeoutMs: number;
  maxRedirects: number;
  verifyTls: boolean;
  /**
   * Ayar (`network.reuse_connections`) açıksa süreç boyu paylaşılan keep-alive havuzunu kullan.
   * Verilmezse yalnızca bu çağrıya özel dispatcher açılır (Postman API çekimi kendi ömrünü yönetir).
   */
  shared?: boolean;
}

export interface ResolvedDispatcher {
  dispatcher: Dispatcher;
  /** İstek aktif proxy üzerinden gidecekse proxy'nin adı; doğrudan gidecekse yok */
  proxyName?: string;
  /** Hata mesajlarında kullanılmak için proxy'nin `host:port`'u */
  proxyHost?: string;
  /** İş bitince çağrılır: özel dispatcher'ı kapatır, paylaşılanı havuzda bırakır */
  release(): void;
}

/** Bu host'lar atlama listesinden bağımsız her zaman doğrudan gider */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Sunucu `Keep-Alive: timeout=N` bildirmezse boşta bağlantı bu kadar açık kalır (undici varsayılanı 4 sn;
 * elle art arda atılan isteklerde kazanç olsun diye uzun). Bildirirse sunucunun değeri (−1 sn) geçerlidir.
 */
const KEEP_ALIVE_TIMEOUT_MS = 30_000;

/**
 * Ana istek (executor.ts), script içi istekler (rq.sendRequest) ve Postman API çekimi aynı ağ
 * ayarlarıyla gönderilir: header/body zaman aşımı, yönlendirme sınırı, TLS doğrulaması (TASARIM.md §8)
 * ve varsa aktif proxy. undici v7'de `maxRedirections` isteğin değil Agent'ın bir interceptor'ıdır.
 *
 * Bağlantı yeniden kullanımı: `shared` çağrılar, ağ ayarları (TLS doğrulaması, yönlendirme
 * sınırı, aktif proxy ve kimlik bilgisi) aynı kaldıkça tek bir doğrudan + tek bir proxy dispatcher'ını
 * paylaşır. Ayarlardan biri değişince anahtar değişir, eski havuz kapatılır (uçuştaki istekler biter) ve
 * yenisi açılır — `verify_tls=false` ile açılmış bir soket doğrulama açıkken asla kullanılmaz. Zaman aşımı
 * çağrıya göre değiştiği için havuzda değil, istek başına (interceptor) uygulanır. Ölçüm (`TimingProbe`)
 * connector'a bağlamdan bağlanır (`timing.ts`), paylaşım ölçümü karıştırmaz.
 *
 * Bilinen sınır: yönlendirme hedefi de aynı dispatcher'ı kullanır; ilk hedef proxy'den gidiyorsa
 * atlama listesindeki bir host'a yönlendirme de proxy üzerinden gider (ve tersi). Yerel bir araç için
 * kabul edilebilir; yönlendirme başına yeniden karar vermek interceptor'ı yeniden yazmayı gerektirir.
 */
export function createDispatcherFor(url: URL, opts: DispatcherOptions): ResolvedDispatcher {
  const proxy = getActiveProxy();
  const viaProxy = proxy != null && !shouldBypassProxy(url.hostname, proxy.bypass);
  const proxyInfo = viaProxy ? { proxyName: proxy.name, proxyHost: new URL(proxy.url).host } : {};

  if (opts.shared && getSetting('network.reuse_connections')) {
    const pool = sharedPool(opts, proxy);
    const base = viaProxy ? (pool.proxied ??= createProxyDispatcher(proxy, opts)) : (pool.direct ??= createDirectDispatcher(opts));
    return { dispatcher: base.compose(requestTimeouts(opts.timeoutMs)), ...proxyInfo, release: () => undefined };
  }
  if (opts.shared) closeSharedPool();

  const own = (viaProxy ? createProxyDispatcher(proxy, opts) : createDirectDispatcher(opts)).compose(
    requestTimeouts(opts.timeoutMs),
  );
  return { dispatcher: own, ...proxyInfo, release: () => void own.close().catch(() => undefined) };
}

/* ---------- Paylaşılan havuz ---------- */

interface SharedPool {
  key: string;
  direct?: Dispatcher;
  proxied?: Dispatcher;
}

let pool: SharedPool | null = null;

/** Havuz anahtarı bellekte bile parolayı düz tutmasın diye özetlenir */
function poolKey(opts: DispatcherOptions, proxy: ActiveProxy | null): string {
  const parts = [opts.verifyTls, opts.maxRedirects, proxy && [proxy.id, proxy.url, proxy.username, proxy.password]];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function sharedPool(opts: DispatcherOptions, proxy: ActiveProxy | null): SharedPool {
  const key = poolKey(opts, proxy);
  if (pool?.key !== key) {
    closeSharedPool();
    pool = { key };
  }
  return pool;
}

/** Ayar değişince ya da yeniden kullanım kapatılınca: boştaki soketler kapanır, uçuştaki istekler biter */
function closeSharedPool(): void {
  if (!pool) return;
  for (const d of [pool.direct, pool.proxied]) void d?.close().catch(() => undefined);
  pool = null;
}

/* ---------- Dispatcher kurulumu ---------- */

/** Doğrulama açıkken gömülü köklere ek olarak işletim sisteminin deposuna da güvenilir (bkz. trustStore.ts) */
function tlsOptions(opts: DispatcherOptions): { rejectUnauthorized: boolean; ca?: string[] } {
  return opts.verifyTls ? { rejectUnauthorized: true, ca: trustedCas() } : { rejectUnauthorized: false };
}

function createDirectDispatcher(opts: DispatcherOptions): Dispatcher {
  return new Agent({
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    connect: probedConnector(buildConnector(tlsOptions(opts))),
  }).compose(interceptors.redirect({ maxRedirections: opts.maxRedirects }));
}

function createProxyDispatcher(proxy: ActiveProxy, opts: DispatcherOptions): Dispatcher {
  const token = proxy.username
    ? `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`
    : undefined;

  return new ProxyAgent({
    uri: proxy.url,
    token,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    // http hedefler düz proxy isteği (GET http://... + Proxy-Authorization), https hedefler CONNECT tüneli.
    // undici'nin varsayılanı her şeyi tünellemek; kurumsal proxy'ler çoğunlukla yalnızca 443'e CONNECT
    // açar, Postman/curl davranışı da budur.
    proxyTunnel: false,
    // Hem proxy'nin kendi sertifikası (https proxy) hem tünel içindeki hedef sertifikası aynı ayara bağlı
    proxyTls: tlsOptions(opts),
    requestTls: tlsOptions(opts),
    // Ölçüm: proxy'ye CONNECT istemcisi (clientFactory) ve hedef / düz proxy istemcileri (factory) bağlamdaki
    // probe'a bağlanır; fabrikalar undici'nin varsayılanlarıyla aynı istemciyi kurar (bkz. timing.ts)
    ...probedFactories(),
  }).compose(interceptors.redirect({ maxRedirections: opts.maxRedirects }));
}

type FactoryOptions = { connect?: unknown; connections?: number | null };

function probedFactories() {
  const wrap = <T extends FactoryOptions>(o: T): T =>
    typeof o.connect === 'function' ? { ...o, connect: probedConnector(o.connect as buildConnector.connector) } : o;
  return {
    clientFactory: (origin: URL, o: Pool.Options) => new Pool(origin, wrap(o)),
    // undici'nin defaultAgentFactory'si: connections === 1 ise Client, değilse Pool
    factory: (origin: string | URL, o: Agent.Options) =>
      o.connections === 1 ? new Client(origin, wrap(o)) : new Pool(origin, wrap(o)),
  };
}

/**
 * Header/body zaman aşımı istek başına (paylaşılan havuzda çağıranlar farklı süre ister); yönlendirmeler devralır.
 * 0 = sınırsız: undici 7.28 `headersTimeout`/`bodyTimeout` 0'da zamanlayıcı kurmaz (client-h1 `setTimeout`
 * `if (delay)`; h2 `stream.setTimeout(0)`). Bağlantı kurma zaman aşımı (connector, 10 sn) bundan ayrıdır.
 */
function requestTimeouts(timeoutMs: number): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (dispatchOpts, handler) =>
    dispatch({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs, ...dispatchOpts }, handler);
}

/* ---------- Bayat bağlantıda tek yineleme ---------- */

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);
/** Yanıt gelmeden soketin kapandığını anlatan hatalar (undici 7.28: boştayken kapatılan soket `UND_ERR_SOCKET`) */
const STALE_SOCKET_CODES = new Set(['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE']);

/**
 * `send`'i (yanıt başlıklarına kadar) `probe` bağlamında koşar. Havuzdan alınan bağlantı karşı taraftan
 * kapanmışsa (sunucu/NAT boşta kapattı, FIN bizden önce ulaşmadı) ve istek idempotent ise bir kez yeni
 * bağlantıyla yineler; tarayıcıların davranışı. Yeni açılmış bağlantıdaki hata ya da POST/PATCH yinelenmez
 * (sunucu isteği işlemiş olabilir). Yalnızca paylaşılan havuzda anlamlıdır; özel dispatcher'da bağlantı
 * hep yenidir, yineleme hiç tetiklenmez.
 */
export async function sendWithStaleRetry<T>(method: string, probe: TimingProbe, send: () => Promise<T>): Promise<T> {
  try {
    return await withProbe(probe, send);
  } catch (err) {
    if (probe.openedConnection || !IDEMPOTENT_METHODS.has(method.toUpperCase()) || !isStaleSocketError(err)) throw err;
    probe.retried = true;
    return withProbe(probe, send);
  }
}

export function isStaleSocketError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return STALE_SOCKET_CODES.has(e?.code ?? '') || STALE_SOCKET_CODES.has(e?.cause?.code ?? '');
}

/**
 * Atlama listesi eşleşmesi (host küçük harfe çevrilir, port yok sayılır):
 * `*` → hepsi; `.suffix` → sonu eşleşen (ve son ekin kendisi, curl/NO_PROXY davranışı); aksi tam eşleşme.
 * Loopback adresleri her zaman doğrudan gider.
 */
export function shouldBypassProxy(hostname: string, bypass: string[]): boolean {
  // URL.hostname IPv6'yı köşeli parantezle verir ("[::1]")
  const host = hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;

  for (const raw of bypass) {
    const entry = normalizeBypassEntry(raw);
    if (entry === '') continue;
    if (entry === '*') return true;
    if (entry.startsWith('.')) {
      if (host.endsWith(entry) || host === entry.slice(1)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

/** Küçük harf, boşluksuz, varsa `:port` eki ve IPv6 köşeli parantezi atılmış */
function normalizeBypassEntry(raw: string): string {
  let entry = raw.trim().toLowerCase();
  const bracketed = /^\[(.*)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1]!;
  // Tek iki nokta varsa "host:port"tur; birden fazlası düz IPv6'dır, dokunma
  if ((entry.match(/:/g) ?? []).length === 1) entry = entry.replace(/:\d+$/, '');
  return entry;
}

/**
 * Proxy üzerinden giden bir istekte undici'nin fırlattığı hatayı kullanıcı diline çevirir; proxy'ye özgü
 * değilse `undefined` döner (çağıran kendi genel eşlemesine düşer). Hata biçimleri undici 7.28 ile
 * deneyle doğrulandı (scratchpad `deney-hatalar.mjs`):
 * - proxy'ye bağlanılamadı → `Error code=ECONNREFUSED "connect ECONNREFUSED <proxy host:port>"` (hedefe değil
 *   proxy'ye bağlanılır; tünelde hedef erişilemezse proxy 502 döner, aşağıda ayrı ele alınır)
 * - 407 düz http → `InvalidArgumentError UND_ERR_INVALID_ARG "Proxy Authentication Required (407)"`
 * - 407 tünel (https) → `AbortError UND_ERR_ABORTED "Proxy response (407) !== 200 when HTTP Tunneling"`
 * - tünelde hedef hatası → `"Proxy response (502) !== 200 when HTTP Tunneling"`
 */
export function describeProxyError(err: unknown, proxyHost: string): string | undefined {
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  const message = e?.message ?? '';

  if (/\(407\)/.test(message)) return msg('proxy.authFailed', { host: proxyHost });
  const tunnel = /Proxy response \((\d+)\)/.exec(message);
  if (tunnel) return msg('proxy.tunnelFailed', { host: proxyHost, status: tunnel[1] });
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EHOSTUNREACH' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return msg('proxy.connectFailed', { host: proxyHost, code });
  }
  return undefined;
}
