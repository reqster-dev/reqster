import {
  HTTP_METHODS,
  type AuthConfig,
  type CurlImportResult,
  type CurlShell,
  type HttpMethod,
  type KeyValueItem,
  type RequestBody,
} from '@reqster/shared';
import { msg } from '../i18n/context.js';

/**
 * Yapıştırılan cURL komutunu kaydedilmemiş bir istek taslağına çevirir.
 *
 * İki sözdizimi desteklenir: bash/zsh (Linux/macOS; `\` satır devamı, `'…'`, `"…"`, `$'…'`) ve
 * Windows `cmd.exe` (`^` satır devamı ve kaçışı, `"…"`, MSVCRT ters bölü kuralları). Chrome/Edge
 * DevTools'un "Copy as cURL (bash)" ve "Copy as cURL (cmd)" çıktıları bu iki biçimdir. Tanınmayan ya
 * da aktarılamayan her bayrak `warnings`'e yazılır (sessizce yutulmaz).
 */

export class CurlParseError extends Error {}

/* ---------------- kabuk algılama + tokenizer ---------------- */

/** `^"` (Chrome cmd çıktısı) ya da satır sonu `^` varsa cmd; aksi halde bash */
export function detectShell(command: string): CurlShell {
  if (/\^"/.test(command) || /\^\r?\n/.test(command)) return 'cmd';
  // `curl.exe` yalnızca Windows'ta yazılır; içinde bash'e özgü tek tırnak/`\` devamı yoksa cmd say
  if (/^\s*curl\.exe\b/i.test(command) && !/\\\r?\n/.test(command) && !command.includes("'")) return 'cmd';
  return 'bash';
}

/** Kabuk denetim karakteri (pipe, `;`, `&&`, yönlendirme) — komutun sonu sayılır */
const BASH_OPERATOR = /[|;&<>]/;

function tokenizeBash(input: string, warnings: string[]): string[] {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let i = 0;
  const push = () => {
    if (inToken) tokens.push(current);
    current = '';
    inToken = false;
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === '\n') {
        i += 2; // satır devamı
        continue;
      }
      if (next === '\r' && input[i + 2] === '\n') {
        i += 3;
        continue;
      }
      if (next !== undefined) {
        current += next;
        inToken = true;
      }
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new CurlParseError(msg('curl.unterminatedQuote'));
      current += input.slice(i + 1, end);
      inToken = true;
      i = end + 1;
      continue;
    }
    if (ch === '$' && input[i + 1] === "'") {
      const [value, next] = readAnsiC(input, i + 2);
      current += value;
      inToken = true;
      i = next;
      continue;
    }
    if (ch === '"') {
      i++;
      let closed = false;
      while (i < input.length) {
        const c = input[i]!;
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === '\\') {
          const next = input[i + 1];
          if (next === '\n') {
            i += 2;
            continue;
          }
          if (next !== undefined && '$`"\\'.includes(next)) {
            current += next;
            i += 2;
            continue;
          }
        }
        current += c;
        i++;
      }
      if (!closed) throw new CurlParseError(msg('curl.unterminatedQuote'));
      inToken = true;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      push();
      i++;
      continue;
    }
    if (BASH_OPERATOR.test(ch) && !isLiteralAmpersand(input, i, inToken)) {
      push();
      const rest = input.slice(i).trim();
      if (rest !== '') warnings.push(msg('curl.trailingIgnored', { text: shorten(rest) }));
      break;
    }
    if (ch === '#' && !inToken) {
      // yorum satır sonuna kadar
      const nl = input.indexOf('\n', i);
      i = nl === -1 ? input.length : nl;
      continue;
    }
    current += ch;
    inToken = true;
    i++;
  }
  push();
  return tokens;
}

/** `$'…'` ANSI-C dizisi: `\n`, `\t`, `\xHH`, `\uHHHH`, `\'` … */
function readAnsiC(input: string, start: number): [string, number] {
  let out = '';
  let i = start;
  while (i < input.length) {
    const c = input[i]!;
    if (c === "'") return [out, i + 1];
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const e = input[i + 1];
    i += 2;
    switch (e) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e': case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(input.slice(i));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      case 'u': case 'U': {
        const m = (e === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(input.slice(i));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += `\\${e}`;
        break;
      }
      case undefined: break;
      default: out += e; // \\ \' \" ve bilinmeyenler
    }
  }
  throw new CurlParseError(msg('curl.unterminatedQuote'));
}

/**
 * cmd.exe iki katmanda okur: önce cmd'nin kendisi `^` kaçışını ve satır devamını işler (tırnak
 * içindeyken `^` düz karakterdir), sonra programın MSVCRT'si argümanları böler (`"` gruplar,
 * `\"` düz tırnak, `""` tırnak içinde düz tırnak, `\` yalnızca `"` öncesinde özeldir).
 */
function tokenizeCmd(input: string, warnings: string[]): string[] {
  // 1. katman: cmd.exe
  let line = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      quoted = !quoted;
      line += ch;
      continue;
    }
    if (!quoted && ch === '^') {
      let next = input[i + 1];
      if (next === '\r' && input[i + 2] === '\n') {
        i++;
        next = '\n';
      }
      if (next === '\n') {
        // satır devamı: `^` + satır sonu silinir, sonraki karakter düz alınır
        i++;
        const after = input[i + 1];
        if (after !== undefined) {
          line += after === '\r' ? '' : after;
          i++;
          if (after === '\r' && input[i + 1] === '\n') {
            line += '\n';
            i++;
          }
        }
        continue;
      }
      if (next !== undefined) line += next;
      i++;
      continue;
    }
    if (!quoted && (ch === '&' || ch === '|' || ch === '<' || ch === '>') && !isLiteralAmpersand(input, i, line !== '' && !/\s$/.test(line))) {
      const rest = input.slice(i).trim();
      if (rest !== '') warnings.push(msg('curl.trailingIgnored', { text: shorten(rest) }));
      break;
    }
    line += ch;
  }

  // 2. katman: MSVCRT argüman bölme
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        current += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          current += '"';
          i += n; // tırnak dahil
        } else {
          i += n - 1; // tırnak bir sonraki turda işlenir
        }
      } else {
        current += '\\'.repeat(n);
        i += n - 1;
      }
      inToken = true;
      continue;
    }
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      inToken = true;
      continue;
    }
    if (!inQuotes && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inQuotes) throw new CurlParseError(msg('curl.unterminatedQuote'));
  if (inToken) tokens.push(current);
  return tokens;
}

/* ---------------- bayrak tablosu ---------------- */

type Handler =
  | 'method' | 'header' | 'data' | 'data-raw' | 'data-binary' | 'data-urlencode' | 'json'
  | 'form' | 'form-string' | 'user' | 'cookie' | 'user-agent' | 'referer' | 'url' | 'get' | 'head'
  | 'url-query' | 'oauth2-bearer' | 'insecure' | 'upload' | 'ignore' | 'ignore-arg' | 'unsupported-auth';

interface OptionSpec {
  handler: Handler;
  takesArg: boolean;
}

const LONG: Record<string, OptionSpec> = {};
const SHORT: Record<string, OptionSpec> = {};
function def(handler: Handler, takesArg: boolean, names: string[]): void {
  for (const n of names) {
    if (n.startsWith('--')) LONG[n.slice(2)] = { handler, takesArg };
    else SHORT[n.slice(1)] = { handler, takesArg };
  }
}
def('method', true, ['-X', '--request']);
def('header', true, ['-H', '--header']);
def('data', true, ['-d', '--data', '--data-ascii']);
def('data-raw', true, ['--data-raw']);
def('data-binary', true, ['--data-binary']);
def('data-urlencode', true, ['--data-urlencode']);
def('json', true, ['--json']);
def('form', true, ['-F', '--form']);
def('form-string', true, ['--form-string']);
def('user', true, ['-u', '--user']);
def('cookie', true, ['-b', '--cookie']);
def('user-agent', true, ['-A', '--user-agent']);
def('referer', true, ['-e', '--referer']);
def('url', true, ['--url']);
def('url-query', true, ['--url-query']);
def('oauth2-bearer', true, ['--oauth2-bearer']);
def('get', false, ['-G', '--get']);
def('head', false, ['-I', '--head']);
def('insecure', false, ['-k', '--insecure']);
def('upload', true, ['-T', '--upload-file']);
def('unsupported-auth', false, ['--digest', '--ntlm', '--negotiate', '--anyauth', '--ntlm-wb']);
// İsteğin içeriğini değiştirmeyen, bilinçli olarak sessiz geçilen bayraklar
def('ignore', false, [
  '-L', '--location', '--location-trusted', '--compressed', '-s', '--silent', '-S', '--show-error', '-v', '--verbose',
  '-i', '--include', '-g', '--globoff', '-f', '--fail', '--fail-with-body', '-#', '--progress-bar', '--no-progress-meter',
  '-N', '--no-buffer', '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3', '-0', '--path-as-is',
  '-4', '--ipv4', '-6', '--ipv6', '--basic', '--ssl-no-revoke', '--ssl-revoke-best-effort', '-q', '--disable',
  '--tr-encoding', '-O', '--remote-name', '-J', '--remote-header-name', '-Z', '--parallel', '--raw', '-l', '--list-only',
]);
// Değer alan ama istek modeline girmeyen bayraklar: değeri tüketilir, uyarı verilir
def('ignore-arg', true, [
  '-o', '--output', '-x', '--proxy', '-U', '--proxy-user', '-m', '--max-time', '--connect-timeout', '-w', '--write-out',
  '-E', '--cert', '--cacert', '--capath', '--key', '--cert-type', '--key-type', '--pass', '-r', '--range', '-c',
  '--cookie-jar', '--retry', '--retry-delay', '--retry-max-time', '-K', '--config', '--interface', '--limit-rate',
  '-Y', '--speed-limit', '-y', '--speed-time', '-z', '--time-cond', '-t', '--telnet-option', '-D', '--dump-header',
  '--max-redirs', '--resolve', '--connect-to', '--noproxy', '--proxy-header', '--aws-sigv4', '--ciphers', '--tlsv1.2',
  '--trace', '--trace-ascii', '--stderr', '--unix-socket', '--abstract-unix-socket', '--dns-servers', '-P', '--ftp-port',
  '-C', '--continue-at', '--max-filesize', '--keepalive-time', '--expect100-timeout', '--happy-eyeballs-timeout-ms',
]);

/* ---------------- ayrıştırma ---------------- */

interface DataPart {
  /** Gönderime girecek biçim (`--data-urlencode` zaten kodlanmış) */
  wire: string;
}

export function parseCurl(command: string): CurlImportResult {
  const warnings: string[] = [];
  const text = command.replace(/^﻿/, '').trim();
  const shell = detectShell(text);
  const tokens = shell === 'cmd' ? tokenizeCmd(text, warnings) : tokenizeBash(text, warnings);

  // Baştaki `$ ` istem karakteri ve `curl`/`curl.exe` (yol önekli olabilir)
  while (tokens[0] === '$' || tokens[0] === '>') tokens.shift();
  const head = tokens.shift();
  if (!head || !/(^|[\\/])curl(\.exe)?$/i.test(head)) throw new CurlParseError(msg('curl.notCurl'));

  let method: string | null = null;
  let forceGet = false;
  let headRequest = false;
  const urls: string[] = [];
  const headers: KeyValueItem[] = [];
  const extraParams: KeyValueItem[] = [];
  const data: DataPart[] = [];
  let urlencodedOnly = true; // tüm veri --data-urlencode ise anahtar/değer olarak al
  const formItems: KeyValueItem[] = [];
  let auth: AuthConfig | null = null;
  let isJsonFlag = false;

  const handle = (spec: OptionSpec, name: string, value: string): void => {
    switch (spec.handler) {
      case 'method':
        method = value.toUpperCase();
        break;
      case 'header': {
        if (value.startsWith('@')) {
          warnings.push(msg('curl.fileArgSkipped', { flag: name, value }));
          break;
        }
        const colon = value.indexOf(':');
        const semicolon = value.indexOf(';');
        if (colon === -1 && semicolon > 0 && semicolon === value.length - 1) {
          headers.push({ key: value.slice(0, -1).trim(), value: '', enabled: true }); // `Ad;` = boş değer
        } else if (colon > 0) {
          const v = value.slice(colon + 1).trim();
          if (v !== '') headers.push({ key: value.slice(0, colon).trim(), value: v, enabled: true });
          // `Ad:` curl'de başlığı kaldırır; taslakta karşılığı yok
        } else {
          warnings.push(msg('curl.badHeader', { value: shorten(value) }));
        }
        break;
      }
      case 'data':
      case 'data-binary':
      case 'json':
        if (value.startsWith('@')) {
          warnings.push(msg('curl.fileArgSkipped', { flag: name, value }));
          break;
        }
        urlencodedOnly = false;
        data.push({ wire: value });
        if (spec.handler === 'json') isJsonFlag = true;
        break;
      case 'data-raw':
        urlencodedOnly = false;
        data.push({ wire: value });
        break;
      case 'data-urlencode': {
        // biçimler: içerik | =içerik | ad=içerik | @dosya | ad@dosya
        const eq = value.indexOf('=');
        const at = value.indexOf('@');
        if (at !== -1 && (eq === -1 || at < eq)) {
          warnings.push(msg('curl.fileArgSkipped', { flag: name, value }));
          break;
        }
        if (eq === -1) {
          urlencodedOnly = false;
          data.push({ wire: encodeForm(value) });
        } else if (eq === 0) {
          urlencodedOnly = false;
          data.push({ wire: encodeForm(value.slice(1)) });
        } else {
          data.push({ wire: `${value.slice(0, eq)}=${encodeForm(value.slice(eq + 1))}` });
        }
        break;
      }
      case 'form':
      case 'form-string': {
        const eq = value.indexOf('=');
        if (eq <= 0) {
          warnings.push(msg('curl.badForm', { value: shorten(value) }));
          break;
        }
        const key = value.slice(0, eq);
        let v = value.slice(eq + 1);
        if (spec.handler === 'form') {
          if (v.startsWith('@') || v.startsWith('<')) {
            warnings.push(msg('curl.formFileSkipped', { key }));
            break;
          }
          // `;type=…` / `;filename=…` ekleri (tırnaksız değerde)
          if (!v.startsWith('"')) {
            const suffix = v.search(/;(type|filename|headers|encoder)=/i);
            if (suffix !== -1) v = v.slice(0, suffix);
          }
          else v = v.replace(/^"(.*)"(;.*)?$/s, '$1');
        }
        formItems.push({ key, value: v, enabled: true });
        break;
      }
      case 'user': {
        const colon = value.indexOf(':');
        if (colon === -1) warnings.push(msg('curl.userNoPassword'));
        auth = {
          type: 'basic',
          basic: colon === -1 ? { username: value, password: '' } : { username: value.slice(0, colon), password: value.slice(colon + 1) },
        };
        break;
      }
      case 'oauth2-bearer':
        auth = { type: 'bearer', bearer: { token: value } };
        break;
      case 'cookie':
        if (!value.includes('=')) {
          warnings.push(msg('curl.cookieFileSkipped', { value }));
          break;
        }
        headers.push({ key: 'Cookie', value, enabled: true });
        break;
      case 'user-agent':
        headers.push({ key: 'User-Agent', value, enabled: true });
        break;
      case 'referer':
        headers.push({ key: 'Referer', value: value.replace(/;auto$/, ''), enabled: true });
        break;
      case 'url':
        urls.push(value);
        break;
      case 'url-query': {
        const eq = value.indexOf('=');
        if (eq > 0) extraParams.push({ key: value.slice(0, eq), value: value.slice(eq + 1), enabled: true });
        else extraParams.push({ key: value.replace(/^[=+]/, ''), value: '', enabled: true });
        break;
      }
      case 'get':
        forceGet = true;
        break;
      case 'head':
        headRequest = true;
        break;
      case 'insecure':
        warnings.push(msg('curl.insecure'));
        break;
      case 'upload':
        warnings.push(msg('curl.fileArgSkipped', { flag: name, value }));
        if (!method) method = 'PUT';
        break;
      case 'unsupported-auth':
        warnings.push(msg('curl.unsupportedAuth', { flag: name }));
        break;
      case 'ignore':
        break;
      case 'ignore-arg':
        warnings.push(msg('curl.optionIgnored', { flag: name }));
        break;
    }
  };

  let onlyPositional = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (onlyPositional || !tok.startsWith('-') || tok === '-') {
      urls.push(tok);
      continue;
    }
    if (tok === '--') {
      onlyPositional = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      let name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      // `--no-xxx` biçimli olumsuzlamalar istek içeriğini değiştirmez
      if (name.startsWith('no-') && !LONG[name]) continue;
      const spec = LONG[name];
      if (!spec) {
        warnings.push(msg('curl.unknownOption', { flag: `--${name}` }));
        continue;
      }
      if (!spec.takesArg) {
        handle(spec, `--${name}`, '');
        continue;
      }
      let value: string | undefined;
      if (eq !== -1) value = tok.slice(eq + 1);
      else value = tokens[++i];
      if (value === undefined) {
        warnings.push(msg('curl.missingValue', { flag: `--${name}` }));
        break;
      }
      name = `--${name}`;
      handle(spec, name, value);
      continue;
    }
    // kısa bayrak kümesi: `-sSL`, `-XPOST`, `-H…`
    for (let j = 1; j < tok.length; j++) {
      const letter = tok[j]!;
      const spec = SHORT[letter];
      if (!spec) {
        warnings.push(msg('curl.unknownOption', { flag: `-${letter}` }));
        continue;
      }
      if (!spec.takesArg) {
        handle(spec, `-${letter}`, '');
        continue;
      }
      let value: string | undefined = tok.slice(j + 1);
      if (value === '') value = tokens[++i];
      if (value === undefined) {
        warnings.push(msg('curl.missingValue', { flag: `-${letter}` }));
        break;
      }
      handle(spec, `-${letter}`, value);
      break; // değerin geri kalanı tükendi
    }
  }

  if (urls.length === 0) throw new CurlParseError(msg('curl.noUrl'));
  if (urls.length > 1) warnings.push(msg('curl.multipleUrls', { url: urls[0]! }));

  // --- URL + query → params ---
  const { url, params } = splitQuery(urls[0]!);
  params.push(...extraParams);

  // --- Authorization başlığı → auth sekmesi ---
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (authIdx !== -1 && !auth) {
    const fromHeader = authFromHeader(headers[authIdx]!.value);
    if (fromHeader) {
      auth = fromHeader;
      headers.splice(authIdx, 1);
    }
  }

  // --- Body ---
  let body: RequestBody | null = null;
  const contentTypeHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  if (forceGet && data.length > 0) {
    // -G: veri query'ye eklenir
    params.push(...parsePairs(data.map((d) => d.wire).join('&')) ?? []);
  } else if (formItems.length > 0) {
    body = { mode: 'form-data', items: formItems };
    if (data.length > 0) warnings.push(msg('curl.dataAndForm'));
    // multipart sınırı istek başına üretilir; komuttaki eski boundary'li başlık kalırsa gövdeyle uyuşmaz
    removeHeader(headers, 'content-type');
  } else if (data.length > 0) {
    const joined = data.map((d) => d.wire).join('&');
    const ct = (contentTypeHeader ?? (isJsonFlag ? 'application/json' : '')).toLowerCase();
    const pairs = parsePairs(joined);
    const isFormCt = ct.startsWith('application/x-www-form-urlencoded');
    if (isJsonFlag) {
      body = { mode: 'raw', raw: joined, contentType: 'application/json' };
      if (!contentTypeHeader) headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ key: 'Accept', value: 'application/json', enabled: true });
    } else if (pairs && (isFormCt || (!ct && (urlencodedOnly || !looksStructured(joined))))) {
      body = { mode: 'urlencoded', items: pairs };
    } else {
      body = { mode: 'raw', raw: joined, contentType: rawContentType(ct, joined) };
    }
  }

  // --- Metot ---
  let finalMethod: string;
  if (method) finalMethod = method;
  else if (headRequest) finalMethod = 'HEAD';
  else if (forceGet) finalMethod = 'GET';
  else if (body) finalMethod = 'POST';
  else finalMethod = 'GET';
  if (!(HTTP_METHODS as readonly string[]).includes(finalMethod)) {
    warnings.push(msg('curl.unsupportedMethod', { method: finalMethod }));
    finalMethod = body ? 'POST' : 'GET';
  }
  if (body && (finalMethod === 'GET' || finalMethod === 'HEAD')) warnings.push(msg('curl.bodyOnGet', { method: finalMethod }));

  return { shell, method: finalMethod as HttpMethod, url, headers, params, body, auth, warnings };
}

/* ---------------- yardımcılar ---------------- */

/**
 * Tırnaksız URL'deki `a=1&b=2` kabukta komut ayırıcıdır, ama yapıştırılan komutlarda hemen hep
 * kullanıcının kastettiği query'dir: kelime ortasındaki tek `&` düz karakter sayılır.
 */
function isLiteralAmpersand(input: string, i: number, inWord: boolean): boolean {
  if (input[i] !== '&' || !inWord) return false;
  const next = input[i + 1];
  return next !== undefined && next !== '&' && !/\s/.test(next);
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ');
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

/** curl --data-urlencode ile aynı: boşluk `+` değil `%20`; `{{var}}` sınırları korunur */
function encodeForm(value: string): string {
  return value
    .split(/(\{\{[^{}]*\}\})/)
    .map((part, i) => (i % 2 === 1 ? part : encodeURIComponent(part)))
    .join('');
}

function decodeForm(value: string): string {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

/** `a=1&b=2` → anahtar/değer; çözülemiyorsa ya da anahtar/değer biçiminde değilse null */
function parsePairs(text: string): KeyValueItem[] | null {
  if (text === '') return [];
  const items: KeyValueItem[] = [];
  for (const part of text.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    if (rawKey === '' || /[\s{}[\]"<>]/.test(rawKey.replace(/\{\{[^{}]*\}\}/g, ''))) return null;
    try {
      items.push({ key: decodeForm(rawKey), value: eq === -1 ? '' : decodeForm(part.slice(eq + 1)), enabled: true });
    } catch {
      return null;
    }
  }
  return items;
}

function looksStructured(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') || t.startsWith('<');
}

function rawContentType(ct: string, text: string): string {
  if (ct) {
    if (ct.includes('json')) return 'application/json';
    if (ct.includes('xml')) return 'application/xml';
    if (ct.includes('html')) return 'text/html';
    return 'text/plain';
  }
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return 'application/json';
    } catch {
      /* JSON değil */
    }
  }
  if (t.startsWith('<')) return 'application/xml';
  return 'text/plain';
}

function splitQuery(rawUrl: string): { url: string; params: KeyValueItem[] } {
  const hash = rawUrl.indexOf('#');
  const noHash = hash === -1 ? rawUrl : rawUrl.slice(0, hash);
  const q = noHash.indexOf('?');
  if (q === -1) return { url: noHash, params: [] };
  const pairs = parsePairs(noHash.slice(q + 1));
  // Çözülemeyen query olduğu gibi URL'de kalır (ör. bozuk %-kodlama)
  if (!pairs) return { url: noHash, params: [] };
  return { url: noHash.slice(0, q), params: pairs };
}

function authFromHeader(value: string): AuthConfig | null {
  const m = /^(\w+)\s+(.+)$/.exec(value.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase();
  const credentials = m[2]!.trim();
  if (scheme === 'bearer') return { type: 'bearer', bearer: { token: credentials } };
  if (scheme === 'basic' && /^[A-Za-z0-9+/]+=*$/.test(credentials)) {
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    // Geçerli UTF-8 değilse (U+FFFD) ya da `kullanıcı:parola` değilse başlık olarak bırak
    if (colon === -1 || decoded.includes('�')) return null;
    return { type: 'basic', basic: { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) } };
  }
  return null;
}

function removeHeader(headers: KeyValueItem[], lowerName: string): void {
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i]!.key.toLowerCase() === lowerName) headers.splice(i, 1);
  }
}
