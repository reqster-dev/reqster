import type { ScriptLogEntry, ScriptTestResult } from '@reqster/shared';
import { getActiveEnvironment } from '../db/repositories/environments.js';
import { newId } from '../db/ids.js';
import { getRequest } from '../db/repositories/requests.js';
import { getSetting } from '../db/repositories/settings.js';
import { deleteVariableByKey, upsertVariable, variableMap } from '../db/repositories/variables.js';
import { currentLang, msg, runWithLang } from '../i18n/context.js';
import { runScript, ScriptCancelledError } from '../scripting/host.js';
import { sendScriptHttpRequest } from './scriptHttp.js';
import type {
  RunScriptResponse,
  ScriptPhase,
  ScriptRequestSnapshot,
  ScriptResponseSnapshot,
  VariableMutation,
  VariableSnapshot,
} from '../scripting/protocol.js';

export interface ScriptChainStep {
  script: string | null;
  /** UI'da hangi script'ten geldiğini göstermek için (örn. "Koleksiyon: Test API") */
  source: string;
}

export interface ScriptChainOutcome {
  requestSnapshot: ScriptRequestSnapshot;
  logs: ScriptLogEntry[];
  tests: ScriptTestResult[];
  /** Zinciri kesen bir script hatası varsa (yalnızca pre-request'te isteği durdurur) */
  fatalError?: string;
  /** Kullanıcı iptal etti: çalışan script durduruldu, kalan adımlar atlandı */
  cancelled?: boolean;
}

function buildVariableSnapshot(
  workspaceId: string,
  collectionId: string | undefined,
  environmentId: string | undefined,
): VariableSnapshot {
  const toRecord = (m: Map<string, { value: string; isSecret: boolean }>) => Object.fromEntries(m);
  return {
    environment: environmentId ? toRecord(variableMap('environment', environmentId)) : {},
    collection: collectionId ? toRecord(variableMap('collection', collectionId)) : {},
    global: toRecord(variableMap('global', workspaceId)),
  };
}

/** Script mutasyonlarını hemen DB'ye yazar (TASARIM.md §5.3: "değişken yazmaları hemen kalıcılaşır") */
function applyMutations(
  mutations: VariableMutation[],
  ctx: { workspaceId: string; collectionId?: string; environmentId?: string },
  source: string,
  logsOut: ScriptLogEntry[],
): void {
  for (const m of mutations) {
    const ownerId =
      m.scope === 'global' ? ctx.workspaceId : m.scope === 'collection' ? ctx.collectionId : ctx.environmentId;
    if (!ownerId) {
      logsOut.push({
        level: 'warn',
        source,
        message: msg(m.scope === 'environment' ? 'execute.mutationNoEnvironment' : 'execute.mutationNoCollection', {
          key: m.key,
          scope: m.scope,
        }),
      });
      continue;
    }
    if (m.action === 'set') {
      upsertVariable({ scope: m.scope, ownerId, key: m.key, value: m.value ?? '' });
    } else {
      deleteVariableByKey(m.scope, ownerId, m.key);
    }
  }
}

/**
 * Bir script zincirini (pre-request: koleksiyon→klasör(ler)→istek,
 * post-response: istek→klasör(ler)→koleksiyon) sırayla çalıştırır.
 * Her adımdan sonra değişken mutasyonları DB'ye yazılır ve BİR SONRAKİ script'in
 * okuyacağı snapshot taze alınır — aynı zincirdeki bir script diğerinin yazdığı
 * değeri görebilsin diye.
 */
export async function runScriptChain(
  steps: ScriptChainStep[],
  phase: ScriptPhase,
  requestSnapshot: ScriptRequestSnapshot,
  responseSnapshot: ScriptResponseSnapshot | undefined,
  ctx: { workspaceId: string; collectionId?: string; requestId?: string },
  signal?: AbortSignal,
): Promise<ScriptChainOutcome> {
  const logs: ScriptLogEntry[] = [];
  const tests: ScriptTestResult[] = [];
  let liveRequest = requestSnapshot;
  // pm.info için: kayıtlı istekse adı, değilse boş string (kayıtsız taslak)
  const savedRequest = ctx.requestId ? getRequest(ctx.requestId) : null;
  // Dil süreç sınırını IPC ile aşar (worker/isolate mesajları); host'taki rq.sendRequest handler'ı IPC
  // olay dinleyicisinden çağrıldığı için AsyncLocalStorage bağlamını kaybeder, burada yeniden kurulur.
  const lang = currentLang();

  for (const step of steps) {
    if (!step.script || step.script.trim() === '') continue;
    if (signal?.aborted) return { requestSnapshot: liveRequest, logs, tests, cancelled: true };

    const activeEnv = getActiveEnvironment(ctx.workspaceId);
    const variables = buildVariableSnapshot(ctx.workspaceId, ctx.collectionId, activeEnv?.id);

    let result: RunScriptResponse;
    try {
      result = await runScript(
        {
          id: newId(),
          script: step.script,
          phase,
          timeoutMs: getSetting('script.timeout_ms'),
          memoryLimitMb: getSetting('script.memory_limit_mb'),
          consoleMaxBytes: getSetting('script.console_max_bytes'),
          variables,
          request: liveRequest,
          response: responseSnapshot,
          environmentName: activeEnv?.name,
          requestName: savedRequest?.name ?? '',
          requestId: savedRequest?.id,
          language: lang,
        },
        // rq.sendRequest: isolate → worker → host; isteği yalnızca host (undici) yapar
        { onSendRequest: (request, opts) => runWithLang(lang, () => sendScriptHttpRequest(request, opts)) },
        signal,
      );
    } catch (err) {
      if (err instanceof ScriptCancelledError) return { requestSnapshot: liveRequest, logs, tests, cancelled: true };
      throw err;
    }

    logs.push(...result.logs.map((l) => ({ ...l, source: step.source })));
    tests.push(...result.tests.map((t) => ({ ...t, source: step.source })));
    applyMutations(
      result.variableMutations,
      { workspaceId: ctx.workspaceId, collectionId: ctx.collectionId, environmentId: activeEnv?.id },
      step.source,
      logs,
    );

    if (!result.ok) {
      return { requestSnapshot: liveRequest, logs, tests, fatalError: `${step.source}: ${result.error}` };
    }
    if (phase === 'pre-request') {
      liveRequest = result.mutatedRequest;
    }
  }

  return { requestSnapshot: liveRequest, logs, tests };
}
