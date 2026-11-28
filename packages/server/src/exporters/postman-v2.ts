import type {
  AuthConfig,
  BundleExportInput,
  ExportOptions,
  FolderModel,
  KeyValueItem,
  RequestBody,
  RequestModel,
  ReqsterBundle,
  VariableModel,
} from '@reqster/shared';
import { BUNDLE_FORMAT } from '@reqster/shared';
import { randomUUID } from 'node:crypto';
import { getCollection, listCollections } from '../db/repositories/collections.js';
import { getEnvironment, listEnvironments } from '../db/repositories/environments.js';
import { listFoldersByCollection } from '../db/repositories/folders.js';
import { listRequestsByCollection } from '../db/repositories/requests.js';
import { listVariables } from '../db/repositories/variables.js';
import { msg } from '../i18n/context.js';
import { appVersion } from '../paths.js';

/**
 * Postman Collection v2.1 dışa aktarımı — `importers/postman-v2.ts`'nin tersi (TASARIM.md §6.2 eşlemesi,
 * simetri kuralı §6.4). Hedef: import → export → import döngüsü kayıpsız olsun. Yalnızca Postman'ın
 * tanıdığı alanlar üretilir; Reqster'a özgü hiçbir ek alan gerekmedi (Reqster veri modeli v2.1'in alt kümesi).
 * `includeSecrets=false` → secret değişkenler anahtarı ve `type: "secret"` ile ama boş değerle gider.
 */

export const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export interface ExportSecretsOption {
  includeSecrets: boolean;
}

/* ---------- Üretilen Postman biçimi (dar: yalnızca yazdığımız alanlar) ---------- */

export interface PmExportKeyValue {
  key: string;
  value: string;
  disabled?: true;
}

export interface PmExportFormField extends Omit<PmExportKeyValue, 'value'> {
  type: 'text' | 'file';
  value?: string;
  /** type=file için yerel dosya yolu */
  src?: string;
}

export interface PmExportAuthParam {
  key: string;
  value: string;
  type: 'string';
}

export interface PmExportAuth {
  type: 'noauth' | 'bearer' | 'basic' | 'apikey';
  bearer?: PmExportAuthParam[];
  basic?: PmExportAuthParam[];
  apikey?: PmExportAuthParam[];
}

export interface PmExportEvent {
  listen: 'prerequest' | 'test';
  script: { type: 'text/javascript'; exec: string[] };
}

export interface PmExportVariable {
  key: string;
  value: string;
  type: 'default' | 'secret';
  disabled?: true;
}

export interface PmExportUrl {
  raw: string;
  protocol?: string;
  host?: string[];
  port?: string;
  path?: string[];
  query?: PmExportKeyValue[];
}

export interface PmExportBody {
  mode: 'raw' | 'urlencoded' | 'formdata';
  raw?: string;
  options?: { raw: { language: string } };
  urlencoded?: PmExportKeyValue[];
  formdata?: PmExportFormField[];
}

export interface PmExportRequest {
  method: string;
  header: PmExportKeyValue[];
  url: PmExportUrl;
  body?: PmExportBody;
  auth?: PmExportAuth;
  description?: string;
}

export interface PmExportItem {
  name: string;
  description?: string;
  /** klasör */
  item?: PmExportItem[];
  /** istek */
  request?: PmExportRequest;
  response?: never[];
  auth?: PmExportAuth;
  event?: PmExportEvent[];
}

export interface PostmanCollectionV21 {
  info: { _postman_id: string; name: string; description?: string; schema: string };
  item: PmExportItem[];
  auth?: PmExportAuth;
  event?: PmExportEvent[];
  variable?: PmExportVariable[];
}

export interface PostmanEnvironmentExport {
  id: string;
  name: string;
  values: Array<{ key: string; value: string; type: 'default' | 'secret'; enabled: boolean }>;
  _postman_variable_scope: 'environment';
  _postman_exported_using: string;
}

/* ---------- Yardımcılar ---------- */

function keyValues(items: KeyValueItem[]): PmExportKeyValue[] {
  return items.map((i) => (i.enabled ? { key: i.key, value: i.value } : { key: i.key, value: i.value, disabled: true }));
}

function authParams(entries: Array<[string, string]>): PmExportAuthParam[] {
  return entries.map(([key, value]) => ({ key, value, type: 'string' }));
}

/** `null` (devral) → alan yok; `none` → `noauth` */
function convertAuth(auth: AuthConfig | null): PmExportAuth | undefined {
  if (!auth) return undefined;
  switch (auth.type) {
    case 'none':
      return { type: 'noauth' };
    case 'bearer':
      return { type: 'bearer', bearer: authParams([['token', auth.bearer?.token ?? '']]) };
    case 'basic':
      return {
        type: 'basic',
        basic: authParams([
          ['username', auth.basic?.username ?? ''],
          ['password', auth.basic?.password ?? ''],
        ]),
      };
    case 'apikey':
      return {
        type: 'apikey',
        apikey: authParams([
          ['key', auth.apikey?.key ?? ''],
          ['value', auth.apikey?.value ?? ''],
          ['in', auth.apikey?.in === 'query' ? 'query' : 'header'],
        ]),
      };
    default:
      return undefined;
  }
}

function convertEvents(preRequestScript: string | null, postResponseScript: string | null): PmExportEvent[] | undefined {
  const events: PmExportEvent[] = [];
  if (preRequestScript && preRequestScript.trim() !== '') {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: preRequestScript.split('\n') } });
  }
  if (postResponseScript && postResponseScript.trim() !== '') {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: postResponseScript.split('\n') } });
  }
  return events.length > 0 ? events : undefined;
}

/** Importer'daki `RAW_LANGUAGE_TO_CONTENT_TYPE` tablosunun tersi; tanınmayan tip `text` olur */
function rawLanguage(contentType: string | undefined): string {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return 'json';
  if (ct.includes('xml')) return 'xml';
  if (ct.includes('html')) return 'html';
  if (ct.includes('javascript')) return 'javascript';
  return 'text';
}

function convertBody(body: RequestBody | null): PmExportBody | undefined {
  if (!body || body.mode === 'none') return undefined;
  switch (body.mode) {
    case 'raw':
      return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: rawLanguage(body.contentType) } } };
    case 'urlencoded':
      return { mode: 'urlencoded', urlencoded: keyValues(body.items ?? []) };
    case 'form-data':
      return {
        mode: 'formdata',
        formdata: (body.items ?? []).map((item): PmExportFormField => {
          const base = item.enabled ? { key: item.key } : { key: item.key, disabled: true as const };
          return item.type === 'file'
            ? { ...base, type: 'file', src: item.value }
            : { ...base, value: item.value, type: 'text' };
        }),
      };
    default:
      return undefined;
  }
}

function queryString(params: PmExportKeyValue[]): string {
  // raw'a yalnızca etkin parametreler girer (Postman da öyle yapar); importer query[]'yi esas alır
  return params
    .filter((p) => !p.disabled)
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&');
}

/**
 * Reqster'ın düz URL'i + params → Postman'ın yapılandırılmış `url` nesnesi. `raw` esastır (importer onu
 * okur); protocol/host/port/path Postman'ın UI'ı için en iyi çabayla ayrıştırılır, `{{var}}` parçaları
 * olduğu gibi kalır (Postman da `{{baseUrl}}`'i host olarak yazar).
 */
function convertUrl(url: string, params: KeyValueItem[]): PmExportUrl {
  const hashIndex = url.indexOf('#');
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const questionIndex = withoutHash.indexOf('?');
  const base = questionIndex >= 0 ? withoutHash.slice(0, questionIndex) : withoutHash;
  // URL'e elle yazılmış `?a=1` parçaları da query[]'ye girer: importer `raw`'ın `?` sonrasını atıp
  // query[]'yi esas aldığı için aksi halde ikinci turda kaybolurlardı
  const inlineQuery: PmExportKeyValue[] =
    questionIndex >= 0
      ? withoutHash
          .slice(questionIndex + 1)
          .split('&')
          .filter((pair) => pair !== '')
          .map((pair) => {
            const eq = pair.indexOf('=');
            return eq >= 0 ? { key: pair.slice(0, eq), value: pair.slice(eq + 1) } : { key: pair, value: '' };
          })
      : [];
  const query = [...inlineQuery, ...keyValues(params)];

  const qs = queryString(query);
  const out: PmExportUrl = { raw: qs ? `${base}?${qs}` : base };

  let rest = base;
  const protocolMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(rest);
  if (protocolMatch) {
    out.protocol = protocolMatch[1]!;
    rest = rest.slice(protocolMatch[0].length);
  }
  const slashIndex = rest.indexOf('/');
  const authority = slashIndex >= 0 ? rest.slice(0, slashIndex) : rest;
  const pathPart = slashIndex >= 0 ? rest.slice(slashIndex + 1) : '';
  if (authority !== '') {
    const portMatch = /^(.*):(\d+|\{\{[^}]*\}\})$/.exec(authority);
    const hostText = portMatch ? portMatch[1]! : authority;
    if (portMatch) out.port = portMatch[2]!;
    out.host = hostText.split('.');
  }
  if (pathPart !== '') out.path = pathPart.split('/');
  if (query.length > 0) out.query = query;
  return out;
}

function convertVariable(v: VariableModel, includeSecrets: boolean): PmExportVariable {
  const out: PmExportVariable = {
    key: v.key,
    value: v.isSecret && !includeSecrets ? '' : v.value,
    type: v.isSecret ? 'secret' : 'default',
  };
  if (!v.enabled) out.disabled = true;
  return out;
}

function convertRequest(r: RequestModel): PmExportItem {
  const request: PmExportRequest = {
    method: r.method,
    header: keyValues(r.headers),
    url: convertUrl(r.url, r.params),
  };
  const body = convertBody(r.body);
  if (body) request.body = body;
  const auth = convertAuth(r.auth);
  if (auth) request.auth = auth;
  if (r.description != null) request.description = r.description;

  const item: PmExportItem = { name: r.name, request, response: [] };
  const event = convertEvents(r.preRequestScript, r.postResponseScript);
  if (event) item.event = event;
  return item;
}

/** Aynı ebeveyn altındaki klasör + istekleri `sort_order` (sonra oluşturulma) sırasıyla tek dizide verir */
function buildItems(
  parentId: string | null,
  folders: FolderModel[],
  requests: RequestModel[],
): PmExportItem[] {
  type Entry = { sortOrder: number; createdAt: number; item: PmExportItem };
  const entries: Entry[] = [];
  for (const f of folders) {
    if (f.parentId !== parentId) continue;
    const item: PmExportItem = { name: f.name };
    if (f.description != null) item.description = f.description;
    item.item = buildItems(f.id, folders, requests);
    const auth = convertAuth(f.auth);
    if (auth) item.auth = auth;
    const event = convertEvents(f.preRequestScript, f.postResponseScript);
    if (event) item.event = event;
    entries.push({ sortOrder: f.sortOrder, createdAt: f.createdAt, item });
  }
  for (const r of requests) {
    if (r.folderId !== parentId) continue;
    entries.push({ sortOrder: r.sortOrder, createdAt: r.createdAt, item: convertRequest(r) });
  }
  entries.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
  return entries.map((e) => e.item);
}

/* ---------- Dışa aktarma akışları ---------- */

export class ExportNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportNotFoundError';
  }
}

export function exportCollection(collectionId: string, options: ExportSecretsOption): PostmanCollectionV21 {
  const collection = getCollection(collectionId);
  if (!collection) throw new ExportNotFoundError(msg('error.collectionNotFound'));

  const out: PostmanCollectionV21 = {
    info: { _postman_id: randomUUID(), name: collection.name, schema: POSTMAN_V21_SCHEMA },
    item: buildItems(null, listFoldersByCollection(collection.id), listRequestsByCollection(collection.id)),
  };
  if (collection.description != null) out.info.description = collection.description;
  const auth = convertAuth(collection.auth);
  if (auth) out.auth = auth;
  const event = convertEvents(collection.preRequestScript, collection.postResponseScript);
  if (event) out.event = event;
  const variables = listVariables('collection', collection.id);
  if (variables.length > 0) out.variable = variables.map((v) => convertVariable(v, options.includeSecrets));
  return out;
}

export function exportEnvironment(environmentId: string, options: ExportSecretsOption): PostmanEnvironmentExport {
  const environment = getEnvironment(environmentId);
  if (!environment) throw new ExportNotFoundError(msg('error.environmentNotFound'));
  return {
    id: randomUUID(),
    name: environment.name,
    values: listVariables('environment', environment.id).map((v) => ({
      key: v.key,
      value: v.isSecret && !options.includeSecrets ? '' : v.value,
      type: v.isSecret ? 'secret' : 'default',
      enabled: v.enabled,
    })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: `Reqster/${appVersion()}`,
  };
}

export function exportGlobals(workspaceId: string, options: ExportSecretsOption): NonNullable<ReqsterBundle['globals']> {
  return {
    values: listVariables('global', workspaceId).map((v) => ({
      key: v.key,
      value: v.isSecret && !options.includeSecrets ? '' : v.value,
      type: v.isSecret ? 'secret' : 'default',
      enabled: v.enabled,
    })),
  };
}

/** Paylaşım paketi: seçilen koleksiyonlar + ortamlar + (istenirse) global'ler, tek JSON */
export function buildBundle(input: BundleExportInput, workspaceId: string): ReqsterBundle {
  const options: ExportSecretsOption = { includeSecrets: input.includeSecrets };
  return {
    format: BUNDLE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    app: `reqster/${appVersion()}`,
    secretsIncluded: input.includeSecrets,
    collections: input.collectionIds.map((id) => exportCollection(id, options)),
    environments: input.environmentIds.map((id) => exportEnvironment(id, options)),
    globals: input.includeGlobals ? exportGlobals(workspaceId, options) : null,
  };
}

function secretCount(variables: VariableModel[]): number {
  return variables.filter((v) => v.isSecret).length;
}

/** Dışa aktarma diyaloğu için seçim listesi */
export function exportOptions(workspaceId: string): ExportOptions {
  const globals = listVariables('global', workspaceId);
  return {
    collections: listCollections(workspaceId).map((c) => ({
      id: c.id,
      name: c.name,
      requestCount: listRequestsByCollection(c.id).length,
      secretCount: secretCount(listVariables('collection', c.id)),
    })),
    environments: listEnvironments(workspaceId).map((e) => ({
      id: e.id,
      name: e.name,
      secretCount: secretCount(listVariables('environment', e.id)),
    })),
    globals: { variableCount: globals.length, secretCount: secretCount(globals) },
  };
}
