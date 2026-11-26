import { bundleExportSchema, curlExportSchema } from '@reqster/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { getDefaultWorkspace } from '../db/repositories/workspaces.js';
import {
  buildBundle,
  exportCollection,
  exportEnvironment,
  ExportNotFoundError,
  exportOptions,
} from '../exporters/postman-v2.js';
import { exportCurl } from '../exporters/curl.js';
import { attachmentHeader, parseBody } from './helpers.js';

/** `attachment; filename="<ascii>"; filename*=UTF-8''<utf8>` — tarayıcı UTF-8 adı tercih eder */
function attachment(reply: FastifyReply, baseName: string, suffix: string): void {
  reply.header('Content-Disposition', attachmentHeader(`${baseName.trim() || 'export'}${suffix}`));
  // UI'ın fetch ile başlığı okuyabilmesi için (Vite proxy ve aynı origin'de zaten görünür; zararsız)
  reply.header('Access-Control-Expose-Headers', 'Content-Disposition');
}

/** `?secrets=1` → secret değerler dahil; varsayılan (yok/0) → boş değer + `type: "secret"` */
function includeSecrets(query: unknown): boolean {
  const value = (query as { secrets?: string } | undefined)?.secrets;
  return value === '1' || value === 'true';
}

function sendExportError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof ExportNotFoundError) return reply.code(404).send({ error: err.message });
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
}

export function exportRoutes(app: FastifyInstance): void {
  app.get('/export/options', () => exportOptions(getDefaultWorkspace().id));

  app.get('/export/collections/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const collection = exportCollection(id, { includeSecrets: includeSecrets(req.query) });
      attachment(reply, collection.info.name, '.collection.json');
      return collection;
    } catch (err) {
      return sendExportError(err, reply);
    }
  });

  app.get('/export/environments/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const environment = exportEnvironment(id, { includeSecrets: includeSecrets(req.query) });
      attachment(reply, environment.name, '.environment.json');
      return environment;
    } catch (err) {
      return sendExportError(err, reply);
    }
  });

  app.post('/export/bundle', (req, reply) => {
    const body = parseBody(bundleExportSchema, req.body, reply);
    if (!body) return;
    try {
      const bundle = buildBundle(body, getDefaultWorkspace().id);
      attachment(reply, `reqster-paket-${bundle.exportedAt.slice(0, 10)}`, '.reqster.json');
      return bundle;
    } catch (err) {
      return sendExportError(err, reply);
    }
  });

  // Taslak → cURL komutu (JSON yanıt, dosya değil: UI panoya kopyalar)
  app.post('/export/curl', (req, reply) => {
    const body = parseBody(curlExportSchema, req.body, reply);
    if (!body) return;
    return exportCurl(body);
  });
}
