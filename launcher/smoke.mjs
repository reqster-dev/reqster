#!/usr/bin/env node
/**
 * Paketlenmiş Reqster ikilisinin duman testi (CI'da Linux paketi üzerinde koşar; Windows paketi
 * aynı kodun yalnızca farklı bir Node ikilisiyle sarılmış hâlidir).
 *
 *   node launcher/smoke.mjs dist/package/linux-x64/Reqster/reqster
 *
 * Kanıtladığı şeyler: exe açılıyor, SEA içinden server.cjs yükleniyor, migration'lar koşuyor
 * (geçici boş veri dizini), frontend aynı porttan sunuluyor, bir istek yürütülüyor ve script
 * sandbox'ı paketlenmiş modda (REQSTER_WORKER_MODE ile ikinci bir Reqster süreci) çalışıp
 * pre/post script log ve test sonuçlarını döndürüyor.
 *
 * İkinci bölüm Tauri sidecar sözleşmesini kabuk olmadan kanıtlar: `REQSTER_PORT=0 REQSTER_SIDECAR=1`
 * ile açılan süreç stdout'a `REQSTER_READY http://127.0.0.1:<port>/` yazar, o porttan API cevap
 * verir ve stdin kapanınca (kabuk öldü) süreç kendi kendine çıkar.
 *
 * Yerel kapı bekçisi: yabancı Host 421, token'sız API 401 (sayfa token istemez), yabancı Origin'li POST 403,
 * `?reqster_token=` ile açılan sayfa yönlendirmeden 200 döner ve yedek çerezi (SameSite=Lax) kurar.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = 'http://127.0.0.1:7357';
// Bölüm 1 token'ı dışarıdan verir (kabuk gibi); bölüm 2'de başlatıcının kendi ürettiği READY adresinden okunur
const TOKEN = 'smoke-' + Math.random().toString(16).slice(2);
const AUTH = { 'x-reqster-token': TOKEN };
const exe = process.argv[2];
if (!exe) {
  console.error('kullanım: node launcher/smoke.mjs <paketlenmiş ikili>');
  process.exit(2);
}

// Tauri sidecar düzeni (src-tauri/binaries/<exe> + src-tauri/resources/): resources exe'nin yanında
// değildir, kabuk onu REQSTER_RESOURCES_DIR ile verir. Burada aynı şeyi yapıp launcher'ın bu
// değişkeni saydığını da sınarız. Taşınabilir pakette (exe yanında resources/) dokunulmaz.
const exeDir = path.dirname(path.resolve(exe));
if (!process.env.REQSTER_RESOURCES_DIR && !existsSync(path.join(exeDir, 'resources', 'server.cjs'))) {
  const tauriResources = path.join(exeDir, '..', 'resources');
  if (existsSync(path.join(tauriResources, 'server.cjs'))) {
    process.env.REQSTER_RESOURCES_DIR = tauriResources;
    console.log(`Tauri sidecar düzeni algılandı; REQSTER_RESOURCES_DIR=${tauriResources}`);
  }
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'reqster-smoke-'));
const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures.push(name);
}

/** Süreci başlatır, stdout/stderr'i biriktirir, çıkışını izler */
function launch(env, stdin) {
  const proc = spawn(exe, [], {
    env: { ...process.env, REQSTER_NO_BROWSER: '1', REQSTER_DATA_DIR: dataDir, ...env },
    stdio: [stdin, 'pipe', 'pipe'],
  });
  const state = { proc, output: '', exited: null };
  proc.stdout.on('data', (d) => (state.output += d));
  proc.stderr.on('data', (d) => (state.output += d));
  proc.on('exit', (code, signal) => (state.exited = { code, signal }));
  return state;
}

/** Süreç kendiliğinden çıkmazsa SIGTERM → 5 sn → SIGKILL; çıkış bilgisini döndürür */
function waitForExit(state, timeoutMs) {
  return new Promise((resolve) => {
    if (state.exited) return resolve(state.exited);
    const t = setTimeout(() => resolve(null), timeoutMs);
    state.proc.once('exit', () => {
      clearTimeout(t);
      resolve(state.exited);
    });
  });
}

async function terminate(state) {
  if (state.exited) return;
  state.proc.kill('SIGTERM');
  if ((await waitForExit(state, 5_000)) === null) {
    state.proc.kill('SIGKILL');
    await waitForExit(state, 2_000);
  }
}

async function waitForServer(state, base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.exited) throw new Error(`süreç erken kapandı: ${JSON.stringify(state.exited)}\n${state.output}`);
    try {
      const res = await fetch(`${base}/api/workspace`, { headers: AUTH });
      if (res.ok) return res.json();
    } catch {
      /* henüz hazır değil */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`sunucu ${timeoutMs} ms içinde hazır olmadı\n${state.output}`);
}

/** Ham HTTP isteği (Host başlığını serbestçe yazmak için); durum kodunu döndürür */
function rawStatus(port, request) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(request));
    let data = '';
    sock.on('data', (d) => (data += d));
    sock.on('end', () => resolve(Number(data.split(' ')[1])));
    sock.on('error', reject);
  });
}

async function execute(scripts) {
  const res = await fetch(`${BASE}/api/execute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({
      method: 'GET',
      url: `${BASE}/api/workspace`,
      headers: [{ key: 'X-Reqster-Token', value: TOKEN, enabled: true }],
      params: [],
      body: null,
      auth: null,
      ...scripts,
    }),
  });
  return { http: res.status, result: await res.json() };
}

// --- Bölüm 1: taşınabilir mod (sabit port 7357, tarayıcısız) ---------------------------------
const main = launch({ REQSTER_SESSION_TOKEN: TOKEN }, 'ignore');
try {
  const ws = await waitForServer(main, BASE, 30_000);
  check('sunucu hazır, workspace döndü', typeof ws?.workspace?.id === 'string');
  check(
    'READY satırı 7357 ile yazıldı',
    main.output.includes(`REQSTER_READY http://127.0.0.1:7357/?reqster_token=${TOKEN}\n`),
    JSON.stringify(main.output.split('\n').filter((l) => l.startsWith('REQSTER_READY'))),
  );

  // --- kapı bekçisi ---
  const anon = await fetch(`${BASE}/api/workspace`);
  check('token\'sız API isteği 401', anon.status === 401, `http ${anon.status}`);
  // Sayfa ve statik dosyalar herkese açık uygulama kodudur; arayüz token'ı adresten alıp API'ye başlıkla yollar
  const anonHome = await fetch(`${BASE}/`);
  check('token\'sız sayfa 200 (statik açık, API kapalı)', anonHome.status === 200, `http ${anonHome.status}`);
  const wrong = await fetch(`${BASE}/api/workspace`, { headers: { 'x-reqster-token': TOKEN + 'x' } });
  check('yanlış token 401', wrong.status === 401, `http ${wrong.status}`);
  // fetch Host başlığını ezmeye izin vermez; ham HTTP ile DNS rebinding'i taklit et
  const rebindStatus = await rawStatus(7357, 'GET /api/workspace HTTP/1.1\r\nHost: evil.example:7357\r\nX-Reqster-Token: ' + TOKEN + '\r\nConnection: close\r\n\r\n');
  check('yabancı Host (DNS rebinding) 421', rebindStatus === 421, `http ${rebindStatus}`);
  const csrf = await fetch(`${BASE}/api/collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', ...AUTH },
    body: JSON.stringify({ name: 'csrf' }),
  });
  check('yabancı Origin\'li POST 403', csrf.status === 403, `http ${csrf.status}`);
  const boot = await fetch(`${BASE}/?reqster_token=${TOKEN}`, { redirect: 'manual' });
  const setCookie = boot.headers.get('set-cookie') ?? '';
  const html = await boot.text();
  check(
    '?reqster_token= sayfayı yönlendirmeden verdi ve yedek çerezi kurdu',
    boot.status === 200 && html.includes('<div id="root"') && setCookie.startsWith('reqster_session_7357=') && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie),
    `http ${boot.status} cookie=${setCookie.split('=')[0]}`,
  );
  const cookie = setCookie.split(';')[0];
  const wrongBoot = await fetch(`${BASE}/?reqster_token=${TOKEN}x`);
  check('yanlış token\'lı açılış çerez kurmaz', !(wrongBoot.headers.get('set-cookie') ?? '').startsWith('reqster_session_'), `set-cookie: ${wrongBoot.headers.get('set-cookie') ? 'var' : 'yok'}`);
  const viaCookie = await fetch(`${BASE}/api/workspace`, { headers: { cookie } });
  check('çerezle API 200', viaCookie.status === 200, `http ${viaCookie.status}`);

  const first = await execute({
    preRequestScript: "console.log('smoke pre ok'); rq.globals.set('smokeVar', '42');",
    postResponseScript:
      "rq.test('durum 200', function () { rq.expect(rq.response.status).to.equal(200); });" +
      "rq.test('global okunuyor', function () { rq.expect(rq.globals.get('smokeVar')).to.equal('42'); });",
  });
  const r = first.result;
  check('execute HTTP 200', first.http === 200, `http ${first.http}`);
  check('hedef yanıt 200', r.status === 200, `status ${r.status} error=${r.error ?? '-'}`);
  check('pre-request script hatasız', r.scriptError === undefined, r.scriptError);
  check(
    'pre-request log geldi',
    Array.isArray(r.scriptLogs) && r.scriptLogs.some((l) => l.message.includes('smoke pre ok')),
    JSON.stringify(r.scriptLogs),
  );
  check(
    'post-response testleri geçti (2/2)',
    Array.isArray(r.testResults) && r.testResults.length === 2 && r.testResults.every((t) => t.passed),
    JSON.stringify(r.testResults),
  );

  // Worker aynı süreçte yeniden kullanılıyor mu, hâlâ sağlıklı mı?
  const second = await execute({ preRequestScript: "console.log('ikinci: ' + rq.globals.get('smokeVar'));" });
  check(
    'ikinci çalıştırma worker\'ı yeniden kullandı',
    second.result.scriptLogs?.some((l) => l.message === 'ikinci: 42'),
    JSON.stringify(second.result.scriptLogs),
  );

  // --- Yanıtı kaydet: ikili ve büyük yanıtın tamamı geçici dosyadan bayt bayt aynı iner ---
  const zipBytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), randomBytes(3 * 1024 * 1024)]);
  const bigText = 'satır ğüşiöç 0123456789\n'.repeat(90_000); // ~2,6 MB, history sınırının (1 MB) üstünde
  const fixture = http.createServer((req, res) => {
    if (req.url === '/zip') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="rapor.zip"' });
      res.end(zipBytes);
    } else {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(bigText);
    }
  });
  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
  const run = async (url) =>
    (
      await fetch(`${BASE}/api/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ method: 'GET', url, headers: [], params: [], body: null, auth: null }),
      })
    ).json();
  const fetchFile = (id) => fetch(`${BASE}/api/responses/${id}/file`, { headers: AUTH });
  try {
    const zip = await run(`${fixtureBase}/zip`);
    check('ikili yanıt: binary işaretli, gövde metne çevrilmedi', zip.binary === true && zip.body === '' && zip.truncated === false, JSON.stringify({ binary: zip.binary, body: zip.body?.length, truncated: zip.truncated }));
    check('ikili yanıt: dosya adı Content-Disposition\'dan', zip.bodyFile?.fileName === 'rapor.zip' && zip.bodyFile?.complete === true && zip.bodyFile?.sizeBytes === zipBytes.length, JSON.stringify(zip.bodyFile));
    const zipFile = await fetchFile(zip.bodyFile?.id);
    const downloaded = Buffer.from(await zipFile.arrayBuffer());
    check('ikili yanıt: indirilen dosya bayt bayt aynı', zipFile.status === 200 && downloaded.equals(zipBytes), `http ${zipFile.status} ${downloaded.length} B`);
    check('ikili yanıt: indirme attachment başlığı taşıyor', (zipFile.headers.get('content-disposition') ?? '').includes('filename="rapor.zip"'), zipFile.headers.get('content-disposition') ?? '');

    const big = await run(`${fixtureBase}/metin`);
    check('büyük metin: arayüze kırpılmış gider', big.truncated === true && big.binary === undefined && big.body.length > 0 && Buffer.byteLength(big.body) <= 1024 * 1024 + 4, `truncated=${big.truncated} ${Buffer.byteLength(big.body ?? '')} B`);
    const bigFile = await fetchFile(big.bodyFile?.id);
    check('büyük metin: dosyada tamamı var, ad adresten + uzantı içerik türünden', (await bigFile.text()) === bigText && big.bodyFile?.fileName === 'metin.txt', JSON.stringify(big.bodyFile));

    const gone = await fetchFile('yok-boyle-bir-yanit');
    check('olmayan yanıt dosyası 404', gone.status === 404, `http ${gone.status}`);
    const hist = await (await fetch(`${BASE}/api/history?limit=2`, { headers: AUTH })).json();
    const zipEntry = (Array.isArray(hist) ? hist : hist.items).find((h) => h.url.endsWith('/zip'));
    const zipDetail = await (await fetch(`${BASE}/api/history/${zipEntry?.id}`, { headers: AUTH })).json();
    check('ikili yanıt history\'ye içerik olarak yazılmadı', zipDetail.responseBody === `<application/zip: ${zipBytes.length} B>`, String(zipDetail.responseBody).slice(0, 60));
  } finally {
    fixture.close();
  }

  const noShell = await fetch(`${BASE}/api/shell/pick-file`, { method: 'POST', headers: AUTH });
  check('dosya seçici: kabuk yokken 501', noShell.status === 501, `http ${noShell.status}`);

  const history = await (await fetch(`${BASE}/api/history?limit=5`, { headers: AUTH })).json();
  check('history yazıldı', Array.isArray(history) ? history.length >= 2 : Array.isArray(history?.items) && history.items.length >= 2);
} catch (err) {
  check('duman testi', false, err instanceof Error ? err.message : String(err));
} finally {
  await terminate(main);
}

// --- Bölüm 2: Tauri sidecar sözleşmesi (dinamik port, READY sinyali, stdin ile yaşam döngüsü) ---
const sidecar = launch({ REQSTER_PORT: '0', REQSTER_SIDECAR: '1' }, 'pipe');
try {
  const readyUrl = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`30 sn içinde REQSTER_READY satırı gelmedi\n${sidecar.output}`)), 30_000);
    let buffered = '';
    const onData = (d) => {
      buffered += d;
      const m = buffered.match(/^REQSTER_READY (\S+)\n/m);
      if (!m) return;
      clearTimeout(deadline);
      sidecar.proc.stdout.off('data', onData);
      resolve(m[1]);
    };
    sidecar.proc.stdout.on('data', onData);
    sidecar.proc.once('exit', () => {
      clearTimeout(deadline);
      reject(new Error(`sidecar süreci READY yazmadan kapandı: ${JSON.stringify(sidecar.exited)}\n${sidecar.output}`));
    });
  });
  const port = Number(new URL(readyUrl).port);
  check('sidecar: READY satırı dinamik portla geldi', readyUrl.startsWith('http://127.0.0.1:') && port > 0 && port !== 7357, readyUrl.replace(/=.*/, '=…'));

  const sidecarToken = new URL(readyUrl).searchParams.get('reqster_token');
  check('sidecar: başlatıcı oturum token\'ı üretti (READY adresinde)', typeof sidecarToken === 'string' && sidecarToken.length === 64, readyUrl.replace(/=.*/, '=…'));
  const base = new URL('/', readyUrl).href;
  const anonSidecar = await fetch(`${base}api/workspace`);
  check('sidecar: token\'sız 401', anonSidecar.status === 401, `http ${anonSidecar.status}`);
  const res = await fetch(`${base}api/workspace`, { headers: { 'x-reqster-token': sidecarToken ?? '' } });
  const body = await res.json().catch(() => null);
  check('sidecar: READY portundan /api/workspace 200', res.status === 200 && typeof body?.workspace?.id === 'string', `http ${res.status}`);

  // Dosya seçici sözleşmesi: arayüz ister → stdout'ta REQSTER_PICK_FILE <id> → kabuk sonucu bildirir → arayüz yolu alır
  const sidecarAuth = { 'x-reqster-token': sidecarToken ?? '' };
  const pickLine = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('REQSTER_PICK_FILE satırı gelmedi')), 5_000);
    let buf = '';
    sidecar.proc.stdout.on('data', (d) => {
      buf += d;
      const m = /^REQSTER_PICK_FILE (\S+)$/m.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const picking = fetch(`${base}api/shell/pick-file`, { method: 'POST', headers: sidecarAuth }).then((x) => x.json());
  const pickId = await pickLine;
  const stale = await (await fetch(`${base}api/internal/picked-file`, { method: 'POST', headers: { ...sidecarAuth, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'eski-istek', path: '/etc/passwd' }) })).json();
  check('dosya seçici: eşleşmeyen kimlik yok sayılır', stale.accepted === false, JSON.stringify(stale));
  const pickedPath = process.platform === 'win32' ? 'C:\\Belgeler\\rapor.pdf' : '/home/kullanici/rapor.pdf';
  await fetch(`${base}api/internal/picked-file`, { method: 'POST', headers: { ...sidecarAuth, 'content-type': 'application/json' }, body: JSON.stringify({ id: pickId, path: pickedPath }) });
  const picked = await picking;
  check('dosya seçici: kabuğun bildirdiği yol arayüze döndü', picked.path === pickedPath, JSON.stringify(picked));

  // Kabuk öldü senaryosu: stdin kapanır → sunucu kendini kapatmalı (sinyal gönderilmez)
  sidecar.proc.stdin.end();
  const exited = await waitForExit(sidecar, 5_000);
  check(
    'sidecar: stdin kapanınca ≤5 sn içinde kendi kendine çıktı (kod 0)',
    exited !== null && exited.code === 0,
    exited ? JSON.stringify(exited) : 'süreç hâlâ çalışıyor',
  );
} catch (err) {
  check('sidecar duman testi', false, err instanceof Error ? err.message : String(err));
} finally {
  await terminate(sidecar);
  rmSync(dataDir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} kontrol başarısız: ${failures.join(', ')}`);
  console.error('\n--- süreç çıktısı (bölüm 1) ---\n' + main.output);
  console.error('\n--- süreç çıktısı (bölüm 2, sidecar) ---\n' + sidecar.output);
  process.exit(1);
}
console.log('\nDuman testi geçti.');
