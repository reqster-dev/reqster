import type { HTTP_METHODS } from '../constants/index.js';

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Header / query param / form alanı satırı */
export interface KeyValueItem {
  key: string;
  value: string;
  enabled: boolean;
  /** Yalnızca form-data: 'file' ise `value` yerel dosya yoludur (yoksa 'text') */
  type?: 'text' | 'file';
}

export type BodyMode = 'none' | 'raw' | 'urlencoded' | 'form-data';

export interface RequestBody {
  mode: BodyMode;
  /** mode=raw için içerik */
  raw?: string;
  /** mode=raw için Content-Type (örn. application/json) */
  contentType?: string;
  /** mode=urlencoded | form-data için alanlar */
  items?: KeyValueItem[];
}

export type AuthType = 'none' | 'bearer' | 'basic' | 'apikey';

export interface AuthConfig {
  type: AuthType;
  bearer?: { token: string };
  basic?: { username: string; password: string };
  apikey?: { key: string; value: string; in: 'header' | 'query' };
}

export interface WorkspaceModel {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface CollectionModel {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  preRequestScript: string | null;
  postResponseScript: string | null;
  /** null = auth yok */
  auth: AuthConfig | null;
  createdAt: number;
  updatedAt: number;
}

export interface FolderModel {
  id: string;
  collectionId: string;
  parentId: string | null;
  name: string;
  description: string | null;
  preRequestScript: string | null;
  postResponseScript: string | null;
  auth: AuthConfig | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface RequestModel {
  id: string;
  collectionId: string;
  folderId: string | null;
  name: string;
  description: string | null;
  method: HttpMethod;
  url: string;
  headers: KeyValueItem[];
  params: KeyValueItem[];
  body: RequestBody | null;
  /** null = üstten devral (inherit) */
  auth: AuthConfig | null;
  preRequestScript: string | null;
  postResponseScript: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Bir koleksiyonun tüm içeriği (UI ağacı bundan kurulur) */
export interface CollectionTree {
  collection: CollectionModel;
  folders: FolderModel[];
  requests: RequestModel[];
}

export interface EnvironmentModel {
  id: string;
  workspaceId: string;
  name: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export type VariableScope = 'environment' | 'collection' | 'global';

export interface VariableModel {
  id: string;
  scope: VariableScope;
  /** scope'a göre environmentId / collectionId / workspaceId */
  ownerId: string;
  key: string;
  value: string;
  isSecret: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Öncelik sırası uygulanmış (ortam → koleksiyon → global) tekil değişken görünümü */
export interface ResolvedVariable {
  key: string;
  value: string;
  isSecret: boolean;
  scope: VariableScope;
  ownerId: string;
}

/** UI'dan gelen çalıştırma isteği: taslağın o anki hali */
export interface ExecuteInput {
  /** Kayıtlı bir isteğe bağlıysa (auth inheritance + history ilişkisi için) */
  requestId?: string;
  collectionId?: string;
  folderId?: string | null;
  method: HttpMethod;
  url: string;
  headers: KeyValueItem[];
  params: KeyValueItem[];
  body: RequestBody | null;
  auth: AuthConfig | null;
  /** İsteğin kendi script'leri (draft'tan gelir); klasör/koleksiyon script'leri DB'den okunur */
  preRequestScript?: string | null;
  postResponseScript?: string | null;
}

export interface ScriptLogEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  /** Hangi script'ten geldiği (örn. "Koleksiyon: Test API", "İstek: Kullanıcı Getir") */
  source: string;
}

export interface ScriptTestResult {
  name: string;
  passed: boolean;
  error?: string;
  source: string;
}

/**
 * Bir yürütmenin süre dökümü. Süreler ms, 0,1 hassasiyetle. `null` = o adım bu yürütmede
 * olmadı ya da ölçülemedi (ör. IP adresine istekte DNS, http'de TLS, hata nedeniyle hiç gelinmeyen adım).
 * Ağ adımları yalnızca ilk bağlantıyı anlatır; yönlendirmeler `waitMs` içinde kalır, sayısı `redirects`'te.
 */
export interface ExecuteTimings {
  /** Script dışı hazırlık: zincir/değişken çözümü, auth, gövde kurulumu */
  prepareMs: number;
  /** Pre-request script zinciri; zincirde script yoksa null */
  preScriptMs: number | null;
  /** İstek kuyruğa girdikten bağlantı açılmaya başlayana kadar */
  socketMs: number | null;
  dnsMs: number | null;
  /** TCP el sıkışması (proxy varsa proxy'ye) */
  tcpMs: number | null;
  /** TLS el sıkışması (proxy varsa yalnızca https proxy'nin kendi TLS'i) */
  tlsMs: number | null;
  /** Proxy CONNECT tüneli + tünel içindeki hedef TLS'i; proxy tüneli yoksa null */
  tunnelMs: number | null;
  /** Bağlantı hazır → yanıt başlıkları (TTFB; yönlendirme adımları dahil) */
  waitMs: number | null;
  /** Yanıt başlıkları → gövdenin son baytı */
  downloadMs: number | null;
  /** Post-response script zinciri; zincirde script yoksa ya da çalışmadıysa null */
  postScriptMs: number | null;
  totalMs: number;
  /** Bağlantı açılmadı, mevcut bağlantı kullanıldı (DNS/TCP/TLS yok) */
  reusedConnection: boolean;
  redirects: number;
  /** İstek proxy üzerinden gitti: TCP/TLS proxy'ye yapılan bağlantıyı anlatır */
  proxied: boolean;
  /**
   * Yeniden kullanılan bağlantı karşı taraftan kapanmıştı; idempotent istek bir kez yeni bağlantıyla
   * yinelendi (ilk deneme `socketMs` içindedir). Bu alan eklenmeden önceki history kayıtlarında yok.
   */
  retried?: boolean;
}

/**
 * Yanıtın tam (kırpılmamış, metne çevrilmemiş) gövdesi: `GET /api/responses/<id>/file` ile indirilir. Geçicidir;
 * yeni yanıtlar geldikçe ve uygulama kapanınca silinir (silinmişse uç 404 döner).
 */
export interface ResponseBodyFile {
  id: string;
  /** Önerilen dosya adı (`Content-Disposition` → adresin son parçası → `response`; uzantı içerik türünden) */
  fileName: string;
  sizeBytes: number;
  /** `false`: yanıt dosya üst sınırını aştı, dosyada yalnızca baş kısım var */
  complete: boolean;
}

export interface ExecuteResult {
  historyId: string;
  /** Ağ hatasında undefined */
  status?: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body: string;
  sizeBytes: number;
  durationMs: number;
  truncated: boolean;
  /** Gövde UTF-8 dışında bir kodlamayla çözüldüyse o kodlamanın adı (`windows-1254`…) */
  charset?: string;
  /** Gövde metin değil (zip, resim, PDF…): `body` boş gelir, içerik yalnızca `bodyFile` ile kaydedilebilir */
  binary?: boolean;
  /** Yanıtın tam gövdesi sunucuda geçici dosyada duruyorsa ("Yanıtı kaydet"); boş gövdede ve hatada yok */
  bodyFile?: ResponseBodyFile;
  error?: string;
  resolvedUrl: string;
  unresolvedVariables: string[];
  scriptLogs: ScriptLogEntry[];
  testResults: ScriptTestResult[];
  /** Pre-request script'i durdurucu hata verdiyse (istek hiç gönderilmedi) */
  scriptError?: string;
  /** Yalnızca `network.verify_tls` kapalıyken `false` döner; UI uyarı gösterir */
  tlsVerified?: boolean;
  /** İstek aktif proxy üzerinden gittiyse proxy'nin adı; doğrudan gittiyse yok */
  viaProxy?: string;
  /** Süre dökümü; eski history kayıtlarında yok */
  timings?: ExecuteTimings;
}

export interface HistorySummary {
  id: string;
  requestId: string | null;
  executedAt: number;
  durationMs: number | null;
  method: string;
  url: string;
  statusCode: number | null;
  responseSize: number | null;
  error: string | null;
}

export interface HistoryDetail extends HistorySummary {
  requestHeaders: Array<[string, string]>;
  requestBody: string | null;
  responseHeaders: Array<[string, string]>;
  responseBody: string | null;
  truncated: boolean;
  /** Bu alan eklenmeden (0003) önceki kayıtlarda null */
  timings: ExecuteTimings | null;
}

export interface ImportSkipped {
  item: string;
  reason: string;
}

export interface ImportReport {
  collections: number;
  folders: number;
  requests: number;
  variables: number;
  environments: number;
  skipped: ImportSkipped[];
  warnings: string[];
}

/* ---------- Proxy profilleri ---------- */

/**
 * Kayıtlı bir HTTP proxy. En fazla biri aktiftir; hiçbiri aktif değilse istekler doğrudan gider.
 * Parola API'den asla geri dönmez (`hasPassword`); ana istek, `rq.sendRequest` ve Postman API çekimi
 * aynı dispatcher'ı kullanır (`engine/dispatcher.ts`).
 */
export interface ProxyProfile {
  id: string;
  name: string;
  /** `http://host:port` ya da `https://host:port` (undici ProxyAgent `uri`) */
  url: string;
  username: string | null;
  hasPassword: boolean;
  /**
   * Proxy'siz, doğrudan gidecek host'lar: tam ad (`intranet.local`), son ek (`.corp.example.com`),
   * IP ya da `localhost`. Eşleşme büyük/küçük harf duyarsız, port yok sayılır.
   */
  bypass: string[];
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ---------- Postman API'den çekme ---------- */

export interface PostmanInventoryItem {
  /** Postman `uid` (ownerId-id); GET /collections/{uid} ve /environments/{uid} için */
  uid: string;
  name: string;
}

export interface PostmanInventoryWorkspace {
  id: string;
  name: string;
  /** personal | team | private | public | partner */
  type: string;
  collections: PostmanInventoryItem[];
  environments: PostmanInventoryItem[];
}

/** POST /api/import/postman-api/inventory yanıtı */
export interface PostmanInventory {
  workspaces: PostmanInventoryWorkspace[];
}

/** POST /api/import/postman-api yanıtı: toplam rapor + tek tek çekilemeyen/aktarılamayan öğeler */
export interface PostmanApiImportResult extends ImportReport {
  failed: ImportSkipped[];
}

/* ---------- Dışa aktarma / paylaşım paketi ---------- */

/**
 * Reqster paylaşım paketi: tek dosyada birden çok koleksiyon (Postman v2.1 JSON), ortam (Postman environment
 * JSON) ve global değişkenler. İçe aktarımda tek transaction'da atomik yüklenir. Secret değişkenler
 * `secretsIncluded=false` iken anahtarıyla ama boş değerle ve `type: "secret"` ile taşınır.
 */
export interface ReqsterBundle {
  format: 'reqster-bundle';
  version: 1;
  /** ISO-8601 */
  exportedAt: string;
  /** Üreten uygulama ve sürümü, ör. "reqster/1.0.0-rc.10" */
  app: string;
  secretsIncluded: boolean;
  /** Postman Collection v2.1 belgeleri (olduğu gibi) */
  collections: unknown[];
  /** Postman environment belgeleri (olduğu gibi) */
  environments: unknown[];
  /** Workspace global'leri Postman globals biçiminde (`values: [{key, value, type, enabled}]`), seçilmediyse null */
  globals: { values: Array<{ key: string; value: string; type?: string; enabled?: boolean }> } | null;
}

/** Dışa aktarma seçim diyaloğu için liste (GET /api/export/options) */
export interface ExportOptions {
  collections: Array<{ id: string; name: string; requestCount: number; secretCount: number }>;
  environments: Array<{ id: string; name: string; secretCount: number }>;
  globals: { variableCount: number; secretCount: number };
}

/* ---------- cURL dönüşümü ---------- */

/** cURL komutunun yazıldığı kabuk: Linux/macOS (bash/zsh) ya da Windows `cmd.exe` */
export type CurlShell = 'bash' | 'cmd';

/** Yapıştırılan cURL komutundan çıkarılan, henüz kaydedilmemiş istek taslağı */
export interface CurlImportResult {
  /** Komutun hangi kabuk sözdizimiyle okunduğu (otomatik algılanır) */
  shell: CurlShell;
  method: HttpMethod;
  url: string;
  headers: KeyValueItem[];
  params: KeyValueItem[];
  body: RequestBody | null;
  /** `null` = komutta kimlik bilgisi yok (üstten devral) */
  auth: AuthConfig | null;
  /** Aktarılamayan / yok sayılan bayraklar (Import kural 5: sessizce yutulmaz) */
  warnings: string[];
}

export interface CurlExportResult {
  command: string;
  /** Çözümlenmiş modda bulunamayan değişkenler (`{{x}}` olarak bırakıldı) */
  unresolvedVariables: string[];
  /** Ör. zincirde pre-request script var ama çalıştırılmadı */
  warnings: string[];
}

/** `GET /api/version` — çalışan uygulamanın sürümü */
export interface AppVersionInfo {
  version: string;
}
