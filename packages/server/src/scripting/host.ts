import { type ChildProcess, fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { currentLang } from '../i18n/context.js';
import { type Lang, t } from '../i18n/messages.js';
import { isPackaged } from '../paths.js';
import type {
  RunScriptRequest,
  RunScriptResponse,
  ScriptHttpRequest,
  ScriptHttpResponse,
  SendRequestResultMessage,
  WorkerToHostMessage,
} from './protocol.js';

/**
 * Host'un worker'a sağladığı dış dünya kapıları. `scripting/` paketi `engine/`i import etmez;
 * undici ile isteği yapan uygulama (engine/scriptHttp.ts) bu handler'ı scriptRunner üzerinden verir.
 */
export interface ScriptHostHandlers {
  /**
   * rq.sendRequest için HTTP isteğini yapar. `timeoutMs` worker'ın kalan script süresidir;
   * uygulama bunu network.timeout_ms ile de sınırlar. `signal` çalıştırma bitince (sonuç, worker
   * ölümü ya da güvenlik zaman aşımı) abort edilir.
   */
  onSendRequest(request: ScriptHttpRequest, opts: { timeoutMs: number; signal: AbortSignal }): Promise<ScriptHttpResponse>;
}

/** Çalışan script kullanıcı tarafından iptal edildiğinde fırlatılır (worker öldürülür) */
export class ScriptCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptCancelledError';
  }
}

/** Başlatıcıya "sunucu değil, script worker'ı ol" diyen ortam değişkeni (bkz. launcher/reqster-launcher.js) */
export const WORKER_MODE_ENV = 'REQSTER_WORKER_MODE';
/** Host-side güvenlik ağı: worker kendi timeout'unu aşıp da hiç yanıt vermezse (asılı kalırsa) devreye girer */
const HOST_TIMEOUT_GRACE_MS = 3_000;

let worker: ChildProcess | null = null;
let workerReady: Promise<void> | null = null;
/** Tek worker üzerinden script çalıştırmaları sıraya alınır (basit, düşük eşzamanlılıklı yerel araç için yeterli) */
let queue: Promise<unknown> = Promise.resolve();

function spawnWorkerProcess(): ChildProcess {
  const stdio: Array<'ignore' | 'inherit' | 'ipc'> = ['ignore', 'inherit', 'inherit', 'ipc'];
  if (isPackaged) {
    // Paketlenmiş modda process.execPath Reqster.exe'dir (Node SEA): verilen bir script yolunu
    // değil, her zaman gömülü başlatıcıyı çalıştırır. Başlatıcı bu ortam değişkenini görünce
    // sunucu yerine resources/worker.cjs'yi yükler. 'ipc' kanalı spawn ile de kurulur.
    return spawn(process.execPath, [], {
      env: { ...process.env, [WORKER_MODE_ENV]: '1' },
      stdio,
      // Windows: GUI kabuktan (Tauri) gizli başlatılan konsol-alt-sistemli bir süreç, kendi
      // çocuğu için yeni bir konsol penceresi açar; windowsHide (CREATE_NO_WINDOW) bunu engeller.
      windowsHide: true,
    });
  }
  const workerPath = fileURLToPath(new URL('./worker-entry.ts', import.meta.url));
  return fork(workerPath, [], { execArgv: ['--import', 'tsx/esm'], stdio });
}

function spawnWorker(lang: Lang): { proc: ChildProcess; ready: Promise<void> } {
  const proc = spawnWorkerProcess();

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === 'ready') {
        proc.off('message', onMessage);
        resolve();
      }
    };
    proc.on('message', onMessage);
    proc.once('error', reject);
    proc.once('exit', (code) => reject(new Error(t(lang, 'script.workerExitedOnStart', { code: String(code) }))));
  });

  proc.on('exit', () => {
    // Worker havuzu (1 adet, lazy): çökerse referans temizlenir, bir sonraki
    // çağrıda otomatik yeniden başlatılır (TASARIM.md §5.1).
    if (worker === proc) {
      worker = null;
      workerReady = null;
    }
  });

  return { proc, ready };
}

/**
 * Worker'ı öldürür ve referansı hemen bırakır: `exit` olayı gecikmeli gelir, o arada sıradaki çalıştırma
 * ölmekte olan sürece gitmemeli (iptalin ardından hemen yeniden gönderim).
 */
function discardWorker(proc: ChildProcess): void {
  if (worker === proc) {
    worker = null;
    workerReady = null;
  }
  proc.kill();
}

function getWorker(lang: Lang): { proc: ChildProcess; ready: Promise<void> } {
  if (!worker) {
    const spawned = spawnWorker(lang);
    worker = spawned.proc;
    workerReady = spawned.ready;
  }
  return { proc: worker, ready: workerReady! };
}

async function runOnce(
  input: RunScriptRequest,
  handlers: ScriptHostHandlers,
  signal?: AbortSignal,
): Promise<RunScriptResponse> {
  // IPC olay dinleyicileri (message/exit) AsyncLocalStorage bağlamını taşımaz; dil baştan yakalanır
  const lang = input.language;
  const cancelledMsg = t(lang, 'execute.cancelled');
  if (signal?.aborted) throw new ScriptCancelledError(cancelledMsg);
  const { proc, ready } = getWorker(lang);
  await ready;
  // Worker açılırken iptal edildiyse script hiç başlatılmaz (worker sağlam kalır)
  if (signal?.aborted) throw new ScriptCancelledError(cancelledMsg);

  return new Promise<RunScriptResponse>((resolve, reject) => {
    let settled = false;
    // Bu çalıştırmanın bekleyen rq.sendRequest çağrıları; çalıştırma nasıl biterse bitsin abort edilir
    const pendingCalls = new Map<string, AbortController>();

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      // Worker gerçekten asılı kaldıysa öldür; bir sonraki istek yeni worker açar
      discardWorker(proc);
      reject(new Error(t(lang, 'script.workerUnresponsive')));
    }, input.timeoutMs + HOST_TIMEOUT_GRACE_MS);

    const onMessage = (msg: WorkerToHostMessage) => {
      if (settled) return;
      if (msg?.type === 'sendRequest') {
        if (msg.runId !== input.id) return;
        void handleSendRequest(msg.callId, msg.request, msg.timeoutMs);
        return;
      }
      if (msg?.type !== 'result' || msg.id !== input.id) return;
      settled = true;
      cleanup();
      resolve(msg);
    };

    async function handleSendRequest(callId: string, request: ScriptHttpRequest, timeoutMs: number) {
      const controller = new AbortController();
      pendingCalls.set(callId, controller);
      let reply: SendRequestResultMessage;
      try {
        const response = await handlers.onSendRequest(request, { timeoutMs, signal: controller.signal });
        reply = { type: 'sendRequestResult', callId, ok: true, response };
      } catch (err) {
        reply = { type: 'sendRequestResult', callId, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      pendingCalls.delete(callId);
      // Çalıştırma bu arada bittiyse (zaman aşımı/worker ölümü) yanıtın gidecek yeri yok
      if (!settled && proc.connected) proc.send(reply);
    }
    // İptal: isolate içindeki kod dışarıdan durdurulamaz, bu yüzden worker öldürülür (o adımın logları
    // kaybolur); bir sonraki çalıştırma yeni worker açar
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      discardWorker(proc);
      reject(new ScriptCancelledError(cancelledMsg));
    };
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(t(lang, 'script.workerExited', { code: String(code) })));
    };

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      proc.off('message', onMessage);
      proc.off('exit', onExit);
      for (const controller of pendingCalls.values()) controller.abort();
      pendingCalls.clear();
    }

    proc.on('message', onMessage);
    proc.on('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.send({ type: 'run', ...input });
  });
}

/** Script çalıştırmalarını tek worker üzerinden sıraya alarak yürütür */
export function runScript(
  input: RunScriptRequest,
  handlers: ScriptHostHandlers,
  signal?: AbortSignal,
): Promise<RunScriptResponse> {
  const result = queue.then(() => runOnce(input, handlers, signal));
  // Sıradaki iş, bu işin başarısız olmasından etkilenmemeli
  queue = result.catch(() => undefined);
  return result;
}

export function shutdownScriptWorker(): void {
  worker?.kill();
  worker = null;
  workerReady = null;
}
