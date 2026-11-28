import type { CurlExportInput, CurlExportResult, CurlShell, KeyValueItem } from '@reqster/shared';
import { getFolderChainLeafToRoot, resolveEffectiveAuth } from '../core/hierarchy.js';
import { buildResolver, collectSecretValues } from '../core/variables/resolve.js';
import { getCollection } from '../db/repositories/collections.js';
import { getRequest } from '../db/repositories/requests.js';
import { getDefaultWorkspace } from '../db/repositories/workspaces.js';
import { createContext, interpolate } from '../engine/interpolate.js';
import { msg } from '../i18n/context.js';

/**
 * İstek taslağını cURL komutuna çevirir. Gönderilecek isteği executor ile aynı
 * kurallarla kurar (devralınan auth, yalnızca etkin satırlar, GET/HEAD'de gövde yok) ama pre-request
 * script çalıştırmaz. `resolveVariables=false` iken `{{var}}` olduğu gibi kalır.
 */
export function exportCurl(input: CurlExportInput): CurlExportResult {
  const workspace = getDefaultWorkspace();
  let folderId = input.folderId;
  if (input.requestId) {
    const saved = getRequest(input.requestId);
    if (saved) folderId = saved.folderId;
  }
  const folders = getFolderChainLeafToRoot(folderId);
  const collection = input.collectionId ? getCollection(input.collectionId) : null;

  const resolver = input.resolveVariables ? buildResolver(workspace.id, input.collectionId) : () => undefined;
  const ctx = createContext(resolver);
  const v = (s: string) => interpolate(s, ctx);

  const headers: Array<[string, string]> = enabled(input.headers).map((h) => [v(h.key), v(h.value)]);
  const query: Array<[string, string]> = enabled(input.params).map((p) => [v(p.key), v(p.value)]);
  let user: string | null = null;

  const auth = resolveEffectiveAuth(input.auth, folders, collection);
  if (auth?.type === 'bearer' && auth.bearer) {
    setHeader(headers, 'Authorization', `Bearer ${v(auth.bearer.token)}`);
  } else if (auth?.type === 'basic' && auth.basic) {
    user = `${v(auth.basic.username)}:${v(auth.basic.password)}`;
  } else if (auth?.type === 'apikey' && auth.apikey) {
    const pair: [string, string] = [v(auth.apikey.key), v(auth.apikey.value)];
    if (auth.apikey.in === 'query') query.push(pair);
    else setHeader(headers, pair[0], pair[1]);
  }

  let url = v(input.url.trim());
  if (query.length > 0) {
    const qs = query.map(([k, val]) => `${encode(k)}=${encode(val)}`).join('&');
    url += (url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?') + qs;
  }

  // Gövde: executor GET/HEAD'de göndermez, komut da göndermez
  const bodyArgs: Array<[string, string]> = [];
  const body = input.method === 'GET' || input.method === 'HEAD' ? null : input.body;
  if (body?.mode === 'raw' && body.raw != null && body.raw !== '') {
    if (body.contentType && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', body.contentType]);
    bodyArgs.push(['--data-raw', v(body.raw)]);
  } else if (body?.mode === 'urlencoded') {
    for (const item of enabled(body.items ?? [])) bodyArgs.push(['--data-urlencode', `${v(item.key)}=${v(item.value)}`]);
  } else if (body?.mode === 'form-data') {
    // --form-string: değer `@`/`<` ile başlasa bile dosya sanılmaz
    for (const item of enabled(body.items ?? [])) {
      bodyArgs.push(
        item.type === 'file'
          ? ['--form', `${v(item.key)}=@${v(item.value)}`]
          : ['--form-string', `${v(item.key)}=${v(item.value)}`],
      );
    }
  }

  // Metot curl'ün kendi çıkarımıyla aynıysa yazılmaz (Postman'deki gibi)
  const args: Array<[string] | [string, string]> = [['--location']];
  if (input.method === 'HEAD') args.push(['--head']);
  else if (!(input.method === 'GET' && bodyArgs.length === 0) && !(input.method === 'POST' && bodyArgs.length > 0)) {
    args.push(['--request', input.method]);
  }
  const lines: string[][] = [];
  const quote = input.shell === 'cmd' ? quoteCmd : quoteBash;
  lines.push(['curl', ...args.flatMap((a) => (a.length === 2 ? [a[0], a[1]] : [a[0]])), quote(url)]);
  for (const [k, val] of headers) lines.push(['--header', quote(`${k}: ${val}`)]);
  if (user !== null) lines.push(['--user', quote(user)]);
  for (const [flag, val] of bodyArgs) lines.push([flag, quote(val)]);

  const warnings: string[] = [];
  const hasPreRequest = [collection?.preRequestScript, ...folders.map((f) => f.preRequestScript), input.preRequestScript].some(
    (s) => s != null && s.trim() !== '',
  );
  if (hasPreRequest) warnings.push(msg('curl.exportScriptsNotRun'));
  if (input.resolveVariables && collectSecretValues(resolver, ctx.usedKeys).some((s) => s !== '')) {
    warnings.push(msg('curl.exportSecretsIncluded'));
  }

  return {
    command: joinLines(lines, input.shell),
    unresolvedVariables: input.resolveVariables ? [...ctx.unresolved] : [],
    warnings,
  };
}

function enabled(items: KeyValueItem[]): KeyValueItem[] {
  return items.filter((i) => i.enabled && i.key.trim() !== '');
}

function hasHeader(headers: Array<[string, string]>, lowerName: string): boolean {
  return headers.some(([k]) => k.toLowerCase() === lowerName);
}

function setHeader(headers: Array<[string, string]>, name: string, value: string): void {
  const idx = headers.findIndex(([k]) => k.toLowerCase() === name.toLowerCase());
  if (idx === -1) headers.push([name, value]);
  else headers[idx] = [name, value];
}

/** URL bileşeni kodlaması; `{{var}}` (çözümlenmemiş) olduğu gibi kalır */
function encode(value: string): string {
  return value
    .split(/(\{\{[^{}]*\}\})/)
    .map((part, i) => (i % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}

function joinLines(lines: string[][], shell: CurlShell): string {
  const cont = shell === 'cmd' ? ' ^\n  ' : ' \\\n  ';
  return lines.map((l) => l.join(' ')).join(cont);
}

/** bash/zsh: tek tırnak; içteki `'` → `'\''` */
export function quoteBash(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * cmd.exe: Chrome DevTools'un "Copy as cURL (cmd)" kaçışı, iki düzeltmeyle. Argüman `^"…^"` ile
 * sarılır ki cmd tırnak kipine girmesin ve her özel karakter `^` ile kaçabilsin; MSVCRT katmanı için
 * `"` → `\"`, ters bölüler YALNIZCA bir tırnaktan (ya da kapanış tırnağından) önce ikilenir (Chrome
 * hepsini ikiler, bu da `a\b`'yi `a\\b` yapar). `%` ortam değişkeni açılımına karşı `%^` ile bölünür.
 * Satır sonu `^` + iki satır sonu olur: ilki kaçışı tetikler, ikincisi düz karakterdir. `{}` `[]` `@`
 * `#` `$` cmd için özel değildir, `{{var}}` okunur kalsın diye kaçılmaz.
 */
export function quoteCmd(value: string): string {
  // Geriye bakış: eşleşme yalnızca ters bölü dizisinin başından denenir (uzun dizide karesel geri izleme olmasın)
  const crt = value.replace(/(?<!\\)(\\*)"/g, '$1$1\\"').replace(/(?<!\\)(\\+)$/, '$1$1');
  return (
    '^"' +
    crt
      .replace(/[^a-zA-Z0-9\s_\-:=+~'/.,?;()*`{}[\]@#$]/g, '^$&')
      .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
      .replace(/\r?\n/g, '^\n\n') +
    '^"'
  );
}
