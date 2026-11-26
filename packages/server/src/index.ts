// Eski REQLY_* ortam değişkenlerini REQSTER_* adlarına taşır; diğer importlardan ÖNCE değerlendirilmeli.
import './envCompat.js';
import fastifyStatic from '@fastify/static';
import { SERVER_HOST, SERVER_PORT } from '@reqster/shared';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { collectionsRoutes } from './api/collections.routes.js';
import { environmentsRoutes } from './api/environments.routes.js';
import { executeRoutes } from './api/execute.routes.js';
import { exportRoutes } from './api/export.routes.js';
import { historyRoutes } from './api/history.routes.js';
import { importRoutes } from './api/import.routes.js';
import { internalRoutes } from './api/internal.routes.js';
import { requestsRoutes } from './api/requests.routes.js';
import { responsesRoutes } from './api/responses.routes.js';
import { proxiesRoutes } from './api/proxies.routes.js';
import { settingsRoutes } from './api/settings.routes.js';
import { getDb } from './db/connection.js';
import { getActiveEnvironment } from './db/repositories/environments.js';
import { getSetting } from './db/repositories/settings.js';
import { getDefaultWorkspace } from './db/repositories/workspaces.js';
import { msg, parseLangHeader, runWithLang } from './i18n/context.js';
import { appDistDir } from './paths.js';
import { shutdownScriptWorker } from './scripting/host.js';
import { clearResponseFiles } from './engine/responseStore.js';
import { registerLocalGuard, TOKEN_QUERY } from './security/localGuard.js';

const app = Fastify({
  logger: { level: 'warn' },
  bodyLimit: 50 * 1024 * 1024, // büyük Postman export dosyaları için
});

// İstek dili: UI her isteğe `X-Reqster-Lang: tr|en` yazar; yoksa Türkçe. Hook'un `done`'ı
// AsyncLocalStorage bağlamı içinde çağrılır, böylece gövde ayrıştırma, route ve altındaki tüm
// async zincir (engine, importers, script host) `msg()` ile aynı dili görür (bkz. i18n/context.ts).
app.addHook('onRequest', (req, _reply, done) => {
  runWithLang(parseLangHeader(req.headers['x-reqster-lang']), done);
});

// Host / Origin / oturum token'ı denetimi (DNS rebinding + CSRF, TASARIM.md §8/2). Dil hook'undan
// sonra kaydedilir ki ret mesajı istek dilinde olsun.
registerLocalGuard(app);

app.register(
  (api, _opts, done) => {
    api.get('/workspace', () => {
      const workspace = getDefaultWorkspace();
      const activeEnvironment = getActiveEnvironment(workspace.id);
      return { workspace, activeEnvironmentId: activeEnvironment?.id ?? null };
    });
    collectionsRoutes(api);
    requestsRoutes(api);
    environmentsRoutes(api);
    historyRoutes(api);
    executeRoutes(api);
    responsesRoutes(api);
    importRoutes(api);
    exportRoutes(api);
    settingsRoutes(api);
    proxiesRoutes(api);
    internalRoutes(api);
    done();
  },
  { prefix: '/api' },
);

/**
 * `index.html`'e kayıtlı temayı ve dili basar: `<html lang="tr">` →
 * `<html lang="en" data-theme="dark|light" data-lang="en">`. Tauri kabuğu her açılışta farklı bir
 * porttan (= farklı origin, boş localStorage) yüklediği için ilk boyamada doğru temayı/dili yalnızca
 * sunucu bilir; `index.html`'deki satır içi script bu değerleri görünce localStorage/sistem
 * tercihine bakmaz. Dil ayarı `auto` ise `data-lang` basılmaz, istemci tarayıcı diline
 * göre karar verir. Masaüstü kabuğunda (sidecar) `data-shell="desktop"` de basılır: frontend
 * dışa aktarmayı "Kaydet…" olarak sunar, sonucu kabuktan gelen olayla bildirir.
 */
function renderIndexHtml(template: string, theme: string, language: 'tr' | 'en' | null): string {
  const shell = process.env.REQSTER_SIDECAR === '1' ? ' data-shell="desktop"' : '';
  return template.replace(/<html\b([^>]*)>/, (_m, attrs: string) => {
    if (!language) return `<html${attrs} data-theme="${theme}"${shell}>`;
    const rest = attrs.replace(/\s+lang="[^"]*"/, ''); // şablondaki sabit lang="tr" yerine kayıtlı dil
    return `<html${rest} data-theme="${theme}" lang="${language}" data-lang="${language}"${shell}>`;
  });
}

/**
 * Build edilmiş frontend varsa aynı porttan sunar (tek process, tek port — çift tıkla-çalıştır
 * senaryosu için). Geliştirme sırasında Vite kendi dev sunucusunu (5173) kullanmaya devam eder;
 * bu, onun yerini almaz, yalnızca `vite build` sonrası ek bir sunum yoludur.
 * `index.html` statik olarak değil, her istekte o anki `ui.theme` ayarı basılarak verilir:
 * `/` ve `/index.html` statik sunumdan çıkarılır (`allowedPath` → not-found handler), SPA
 * fallback'i ile aynı yoldan geçer; bu yüzden önbelleğe alınmaz.
 */
async function registerStaticFrontend(): Promise<void> {
  const indexHtmlPath = path.join(appDistDir, 'index.html');
  if (!existsSync(indexHtmlPath)) {
    // Frontend build'i yok (geliştirme): yine de /api altındaki bilinmeyen yol aynı gövdeyle 404 döner
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ error: msg('error.notFound') });
    });
    return;
  }

  await app.register(fastifyStatic, {
    root: appDistDir,
    index: false,
    allowedPath: (pathname) => pathname !== '/' && pathname !== '/index.html',
  });
  const indexHtml = readFileSync(indexHtmlPath, 'utf8');
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api')) {
      reply.code(404).send({ error: msg('error.notFound') });
      return;
    }
    reply
      .code(200)
      .type('text/html')
      .header('Cache-Control', 'no-cache')
      // Yalnızca bilinen değerler HTML'e girer (DB'ye zod dışından bozuk değer girse bile kaçış gerekmez)
      .send(renderIndexHtml(indexHtml, getSetting('ui.theme') === 'light' ? 'light' : 'dark', pinnedLanguage()));
  });
}

/** `ui.language` ayarı `tr`/`en` ise o (HTML'e basılır), `auto` ya da bozuksa null */
function pinnedLanguage(): 'tr' | 'en' | null {
  const value = getSetting('ui.language');
  return value === 'tr' || value === 'en' ? value : null;
}

/**
 * Dinlenecek port. `REQSTER_PORT` verilmişse onu kullanır: `0` → işletim sistemi boş bir port
 * seçer (Tauri sidecar modu; gerçek port `REQSTER_READY` satırıyla kabuğa bildirilir).
 * Verilmemişse varsayılan `SERVER_PORT` (7357).
 */
function resolvePort(): number {
  const raw = process.env.REQSTER_PORT;
  if (raw === undefined || raw === '') return SERVER_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`REQSTER_PORT geçersiz: "${raw}" (0–65535 arası bir tam sayı olmalı; 0 = dinamik port)`);
  }
  return port;
}

let shuttingDown = false;

/** Script worker'ı (ayrı süreç) yetim bırakmadan sunucuyu kapatır; birden fazla tetiklenirse ilkini uygular */
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownScriptWorker();
  void app.close().finally(() => process.exit(0));
}

async function main(): Promise<void> {
  getDb(); // migration'ları uygula
  getDefaultWorkspace(); // ilk açılışta workspace'i garanti et
  clearResponseFiles(); // önceki oturumun geçici yanıt dosyaları
  await registerStaticFrontend();
  // Gizlilik sınırı (TASARIM.md §8): yalnızca loopback'e bağlan
  // Varsayılan yalnızca loopback (yerel araç). Container'da REQSTER_HOST=0.0.0.0 ile dışa açılır;
  // bu durumda önüne kimlik doğrulayan bir katman (Cloudflare Access) konmalıdır (TASARIM.md §8).
  const host = process.env.REQSTER_HOST || SERVER_HOST;
  const port = resolvePort();
  await app.listen({ host, port });
  // Dinamik portta (REQSTER_PORT=0) gerçek port ancak listen'dan sonra bilinir
  const address = app.server.address() as AddressInfo | null;
  const actualPort = address?.port ?? port;
  console.log(`reqster server → http://${host}:${actualPort}`);
  // Kabuk (Tauri) için hazır sinyali: tek satır, sabit önek. Host 0.0.0.0 olsa bile kabuk
  // sunucuya hep loopback'ten ulaşır, bu yüzden URL'de 127.0.0.1 kalır.
  // Oturum token'ı varsa adres onu taşır: kabuk bu adresi açınca sunucu çerezi kurar (security/localGuard.ts).
  const token = process.env.REQSTER_SESSION_TOKEN;
  const query = token ? `?${TOKEN_QUERY}=${encodeURIComponent(token)}` : '';
  process.stdout.write(`REQSTER_READY http://127.0.0.1:${actualPort}/${query}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, shutdown);
  }

  // Sidecar modu: kabuk stdin'i pipe olarak açık tutar; kabuk çökerse (stdin kapanır)
  // sunucu yetim kalmasın diye kendini kapatır.
  if (process.env.REQSTER_SIDECAR === '1') {
    process.stdin.resume();
    process.stdin.once('end', shutdown);
    process.stdin.once('close', shutdown);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
