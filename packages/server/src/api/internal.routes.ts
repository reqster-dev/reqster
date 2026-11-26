import type { FastifyInstance } from 'fastify';
import { completeFilePick, isDesktopSidecar, requestFilePick } from '../core/filePicker.js';
import { buildProxyUrl } from '../core/proxyUrl.js';
import { getActiveProxy } from '../db/repositories/proxies.js';
import { msg } from '../i18n/context.js';

/**
 * Yalnızca masaüstü kabuğunun (Tauri, `src-tauri/src/lib.rs`) kullandığı uçlar. Tarayıcı UI'ı bu
 * uçları kullanmaz; sunucu zaten `127.0.0.1`'e bağlıdır.
 *
 * `GET /internal/proxy-url` aktif proxy'nin kimlik bilgisi DAHİL tam URL'ini döner. Parola burada
 * bilerek açıktır: kabuğun güncelleme denetimi (updater) kurumsal ağlarda ancak aynı proxy'den
 * geçerek dışarı çıkabilir ve Rust tarafı DB'ye erişmez. Kullanıcıya açık `GET /api/proxies`
 * parolayı yine de vermez (`hasPassword`), o kural burada değişmez.
 *
 * Dosya seçici (`core/filePicker.ts`): arayüz `POST /shell/pick-file` ile ister ve yanıtı bekler; kabuk yerel
 * diyaloğun sonucunu `POST /internal/picked-file` ile bildirir. Kabuk yokken (tarayıcı modu) 501.
 */
export function internalRoutes(app: FastifyInstance): void {
  app.get('/internal/proxy-url', () => {
    const proxy = getActiveProxy();
    return { url: proxy ? buildProxyUrl(proxy) : null };
  });

  app.post('/shell/pick-file', async (_req, reply) => {
    if (!isDesktopSidecar()) return reply.code(501).send({ error: msg('shell.pickUnavailable') });
    return { path: await requestFilePick() };
  });

  app.post('/internal/picked-file', (req, reply) => {
    const body = req.body as { id?: unknown; path?: unknown } | null;
    if (typeof body?.id !== 'string' || !(typeof body.path === 'string' || body.path === null)) {
      return reply.code(400).send({ error: msg('validation.failed') });
    }
    return { accepted: completeFilePick(body.id, body.path) };
  });
}
