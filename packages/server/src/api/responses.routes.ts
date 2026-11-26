import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'node:fs';
import { getStoredResponse } from '../engine/responseStore.js';
import { msg } from '../i18n/context.js';
import { attachmentHeader } from './helpers.js';

/** "Yanıtı kaydet": son yanıtların tam gövdesi (bkz. `engine/responseStore.ts`) */
export function responsesRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>('/responses/:id/file', (req, reply) => {
    const entry = getStoredResponse(req.params.id);
    if (!entry || !existsSync(entry.path)) {
      return reply.code(404).send({ error: msg('response.fileGone') });
    }
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', entry.sizeBytes)
      .header('Content-Disposition', attachmentHeader(entry.fileName))
      .header('Cache-Control', 'no-store')
      .send(createReadStream(entry.path));
  });
}
