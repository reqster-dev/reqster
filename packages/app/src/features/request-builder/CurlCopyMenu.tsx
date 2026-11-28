import type { CurlExportResult, CurlShell } from '@reqster/shared';
import { Check, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { DropdownMenu, type MenuItem } from '../../components/DropdownMenu';
import { copyText } from '../../lib/clipboard';
import { useT } from '../../lib/i18n';
import { iconProps } from '../../lib/icons';
import { selectActiveTab, toExecuteInput, useAppStore } from '../../stores/appStore';

/** Kopyalandı geri bildiriminin tetik düğmesinde kalma süresi */
const COPIED_MS = 1500;

/**
 * URL satırındaki "cURL olarak kopyala" menüsü. Komutu sunucu üretir (`/api/export/curl`);
 * uyarı / çözülemeyen değişken varsa kopyalama yine yapılır, ardından kısa bildirim gösterilir.
 */
export function CurlCopyMenu() {
  const t = useT();
  const showNotice = useAppStore((s) => s.showNotice);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async (shell: CurlShell, resolveVariables: boolean) => {
    const { draft } = selectActiveTab(useAppStore.getState());
    let result: CurlExportResult;
    try {
      result = await api.post<CurlExportResult>('/export/curl', { ...toExecuteInput(draft), shell, resolveVariables });
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!(await copyText(result.command))) {
      showNotice(t('curl.copy.failed'));
      return;
    }
    clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
    const notes = [...result.warnings];
    if (result.unresolvedVariables.length > 0) {
      notes.push(t('notice.unresolvedVariables', { list: result.unresolvedVariables.join(', ') }));
    }
    if (notes.length > 0) showNotice(t('curl.copy.copiedWithNotes', { notes: notes.join(' · ') }));
  };

  const resolvedLabel = (key: 'curl.copy.resolvedBash' | 'curl.copy.resolvedCmd') => (
    <span className="curl-menu-label">
      {t(key)}
      <span className="curl-menu-hint">{t('curl.copy.resolvedHint')}</span>
    </span>
  );

  const items: MenuItem[] = [
    { label: t('curl.copy.bash'), onSelect: () => void copy('bash', false) },
    { label: t('curl.copy.cmd'), onSelect: () => void copy('cmd', false) },
    { kind: 'separator' },
    {
      label: resolvedLabel('curl.copy.resolvedBash'),
      title: t('curl.copy.resolvedTitle'),
      onSelect: () => void copy('bash', true),
    },
    {
      label: resolvedLabel('curl.copy.resolvedCmd'),
      title: t('curl.copy.resolvedTitle'),
      onSelect: () => void copy('cmd', true),
    },
  ];

  return (
    <DropdownMenu
      className={`curl-copy-btn ${copied ? 'copied' : ''}`}
      title={t('curl.copy.title')}
      ariaLabel={t('curl.copy.title')}
      label={
        <span className="curl-copy-label">
          {copied ? <Check {...iconProps} /> : <Terminal {...iconProps} />}
          {copied && <span role="status">{t('curl.copy.copied')}</span>}
        </span>
      }
      items={items}
    />
  );
}
