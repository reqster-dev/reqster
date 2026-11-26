import type { ResponseBodyFile } from '@reqster/shared';
import { CircleCheck, CircleX, Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CodeEditor } from '../../components/LazyCodeEditor';
import { downloadFromApi, isDesktopShell } from '../../lib/download';
import { formatByLanguage, languageFromContentType, sniffLanguage } from '../../lib/formatters';
import { useT } from '../../lib/i18n';
import { iconProps } from '../../lib/icons';
import { selectActiveTab, useAppStore } from '../../stores/appStore';
import { TimingsPopover } from './TimingsPopover';

type Tab = 'body' | 'headers' | 'console' | 'tests';

function statusClass(status?: number): string {
  if (status == null) return 'status-none';
  if (status < 300) return 'status-2xx';
  if (status < 400) return 'status-3xx';
  if (status < 500) return 'status-4xx';
  return 'status-5xx';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Masaüstünde "Kaydet…", tarayıcıda "İndir" (dışa aktarma düğmeleriyle aynı adlandırma) */
function saveLabelKey(): 'export.save' | 'export.download' {
  return isDesktopShell() ? 'export.save' : 'export.download';
}

/** Sunucudaki geçici yanıt dosyasını indirir; dosya silinmişse (404) sunucunun mesajı bildirim olur */
function SaveResponseButton({ file }: { file: ResponseBodyFile }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await downloadFromApi(`/responses/${encodeURIComponent(file.id)}/file`, file.fileName);
    } catch (err) {
      useAppStore.getState().showNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className="ghost-btn save-response-btn"
      onClick={() => void save()}
      disabled={busy}
      title={file.complete ? t('response.save.title') : t('response.save.partial')}
    >
      <Download {...iconProps} /> {busy ? t('export.downloading') : t(saveLabelKey())}
    </button>
  );
}

/** Gönderim başladığından beri geçen süreyi canlı gösterir */
function LiveTimer({ since }: { since: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 50);
    return () => clearInterval(id);
  }, []);
  return <span className="meta-item live-timer">{Math.max(0, nowMs - since)} ms</span>;
}

export function ResponseViewer() {
  const response = useAppStore((s) => selectActiveTab(s).response);
  const executingSince = useAppStore((s) => selectActiveTab(s).executingSince);
  const [tab, setTab] = useState<Tab>('body');
  // Ham: sunucunun gönderdiği metin, yeniden biçimlendirilmeden
  const [rawView, setRawView] = useState(false);
  const t = useT();

  const contentType = response?.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
  const language = useMemo(() => {
    if (!response) return 'text' as const;
    const fromHeader = languageFromContentType(contentType);
    return fromHeader !== 'text' ? fromHeader : sniffLanguage(response.body);
  }, [response, contentType]);
  const prettyBody = useMemo(() => {
    if (!response) return '';
    try {
      return formatByLanguage(response.body, language);
    } catch {
      return response.body;
    }
  }, [response, language]);

  const executing = executingSince != null;
  const progress = executing ? <div className="progress-bar" role="progressbar" aria-label={t('response.sending')} /> : null;

  if (!response) {
    return (
      <div className="response-viewer empty">
        {progress}
        {executing ? (
          <>
            <p>{t('response.sending')}</p>
            <LiveTimer since={executingSince} />
          </>
        ) : (
          <p>{t('response.empty')}</p>
        )}
      </div>
    );
  }

  const failedTests = response.testResults.filter((t) => !t.passed).length;
  const binaryCard = response.binary === true && !response.error;

  return (
    <div className="response-viewer">
      {progress}
      <div className="response-meta">
        {response.error ? (
          <span className="status-badge status-5xx">{response.scriptError ? t('response.badge.scriptError') : t('response.badge.error')}</span>
        ) : (
          <span className={`status-badge ${statusClass(response.status)}`}>
            {response.status ?? '—'}
          </span>
        )}
        {executing ? (
          <LiveTimer since={executingSince} />
        ) : response.timings ? (
          <TimingsPopover
            timings={response.timings}
            label={response.scriptError ? Math.round(response.timings.totalMs) : response.durationMs}
          />
        ) : (
          !response.scriptError && <span className="meta-item">{response.durationMs} ms</span>
        )}
        {!response.scriptError && <span className="meta-item">{formatSize(response.sizeBytes)}</span>}
        {response.truncated && (
          <span
            className="meta-item warn"
            title={response.bodyFile ? t('response.truncated.saveHint', { action: t(saveLabelKey()) }) : undefined}
          >
            {t('response.truncated')}
          </span>
        )}
        {response.charset && (
          <span className="meta-badge" title={t('response.charset.title', { charset: response.charset })}>
            {response.charset}
          </span>
        )}
        {response.tlsVerified === false && (
          <span className="meta-item warn" title={t('response.tlsOff.title')}>
            {t('response.tlsOff')}
          </span>
        )}
        {response.viaProxy && (
          <span className="meta-badge" title={t('response.viaProxy.title', { name: response.viaProxy })}>
            {t('response.viaProxy', { name: response.viaProxy })}
          </span>
        )}
        {response.testResults.length > 0 && (
          <span className={`meta-item ${failedTests > 0 ? 'warn' : ''}`}>
            {t('response.tests', { passed: response.testResults.length - failedTests, total: response.testResults.length })}
          </span>
        )}
        {/* İkili yanıtta Body sekmesindeki kart aynı düğmeyi taşır; iki kez görünmesin */}
        {response.bodyFile && !(binaryCard && tab === 'body') && <SaveResponseButton file={response.bodyFile} />}
        <span className="meta-url" title={response.resolvedUrl}>
          {response.resolvedUrl}
        </span>
      </div>

      <div className="tabs">
        <button className={`tab ${tab === 'body' ? 'active' : ''}`} onClick={() => setTab('body')}>
          {t('response.tab.body')}
        </button>
        <button className={`tab ${tab === 'headers' ? 'active' : ''}`} onClick={() => setTab('headers')}>
          {t('response.tab.headers')} {response.headers.length > 0 && `(${response.headers.length})`}
        </button>
        <button className={`tab ${tab === 'console' ? 'active' : ''}`} onClick={() => setTab('console')}>
          {t('response.tab.console')} {response.scriptLogs.length > 0 && `(${response.scriptLogs.length})`}
        </button>
        <button className={`tab ${tab === 'tests' ? 'active' : ''}`} onClick={() => setTab('tests')}>
          {t('response.tab.tests')} {response.testResults.length > 0 && `(${response.testResults.length - failedTests}/${response.testResults.length})`}
        </button>
        {tab === 'body' && !response.error && !binaryCard && (
          <div className="view-toggle" role="group" aria-label={t('response.view.label')}>
            <button className={rawView ? '' : 'active'} aria-pressed={!rawView} onClick={() => setRawView(false)}>
              {t('response.view.pretty')}
            </button>
            <button
              className={rawView ? 'active' : ''}
              aria-pressed={rawView}
              onClick={() => setRawView(true)}
              title={t('response.view.raw.title')}
            >
              {t('response.view.raw')}
            </button>
          </div>
        )}
      </div>

      {tab === 'body' &&
        (response.error ? (
          <pre className="response-body error-text">{response.error}</pre>
        ) : binaryCard ? (
          <div className="binary-card">
            <h3>{t('response.binary.title')}</h3>
            <p className="hint">{t('response.binary.hint')}</p>
            <dl>
              <dt>{t('response.binary.contentType')}</dt>
              <dd>{contentType?.split(';')[0]?.trim() || '—'}</dd>
              <dt>{t('response.binary.size')}</dt>
              <dd>{formatSize(response.bodyFile?.sizeBytes ?? response.sizeBytes)}</dd>
              {response.bodyFile && (
                <>
                  <dt>{t('response.binary.fileName')}</dt>
                  <dd className="binary-card-file">{response.bodyFile.fileName}</dd>
                </>
              )}
            </dl>
            {response.bodyFile && <SaveResponseButton file={response.bodyFile} />}
          </div>
        ) : (
          <CodeEditor
            className="response-body-editor"
            value={rawView ? response.body : prettyBody}
            language={language}
            readOnly
            minHeightPx={60}
          />
        ))}

      {tab === 'headers' && (
        <div className="response-scroll">
          <table className="headers-table">
            <tbody>
              {response.headers.map(([key, value], i) => (
                <tr key={i}>
                  <td className="header-key">{key}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'console' && (
        <div className="console-panel response-scroll">
          {response.scriptLogs.length === 0 && <p className="hint">{t('response.console.empty')}</p>}
          {response.scriptLogs.map((entry, i) => (
            <div key={i} className={`console-line console-${entry.level}`}>
              <span className="console-source">{entry.source}</span>
              <span className="console-message">{entry.message}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'tests' && (
        <div className="tests-panel response-scroll">
          {response.testResults.length === 0 && <p className="hint">{t('response.tests.empty')}</p>}
          {response.testResults.map((test, i) => (
            <div key={i} className={`test-line ${test.passed ? 'test-pass' : 'test-fail'}`}>
              <span className="test-icon">{test.passed ? <CircleCheck {...iconProps} /> : <CircleX {...iconProps} />}</span>
              <span className="test-name">{test.name}</span>
              <span className="console-source">{test.source}</span>
              {!test.passed && test.error && <div className="test-error">{test.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
