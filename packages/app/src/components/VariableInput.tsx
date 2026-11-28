import type { ResolvedVariable } from '@reqster/shared';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/client';
import { useT, type MessageKey } from '../lib/i18n';
import { iconProps } from '../lib/icons';
import { useResolvedVariables } from '../lib/resolvedVariables';
import { useAppStore } from '../stores/appStore';

const VAR_SPLIT = /(\{\{\s*[\w.-]+\s*\}\})/g;
const VAR_KEY = /\{\{\s*([\w.-]+)\s*\}\}/;

const SCOPE_LABELS: Record<string, MessageKey> = {
  environment: 'varTip.scope.environment',
  collection: 'varTip.scope.collection',
  global: 'varTip.scope.global',
};

interface TooltipState {
  varKey: string;
  rect: DOMRect;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  collectionId?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** `preventDefault` çağrılırsa metin input'a yapıştırılmaz (ör. URL kutusunda cURL algılama) */
  onPaste?: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  onBlur?: () => void;
  /**
   * true: metin `type=password` ile maskelenir ve overlay çizilmez (vurgu yok). Aynı input
   * öğesi kalır, yalnızca tipi değişir; böylece maske yazarken açılıp kapansa da odak kaybolmaz.
   */
  masked?: boolean;
}

/**
 * {{degisken}} ifadelerini vurgulayan input: metin, input'un üzerine bindirilmiş
 * bir overlay'de çizilir (input metni şeffaftır); değişken span'ları hover'da
 * değer/scope tooltip'i açar ve yerinde düzenlemeye izin verir.
 */
export function VariableInput({
  value,
  onChange,
  placeholder,
  className,
  collectionId,
  onKeyDown,
  onPaste,
  onBlur,
  masked = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const resolved = useResolvedVariables(collectionId);

  const syncScroll = () => {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  };
  useEffect(syncScroll, [value]);

  const scheduleClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setTooltip(null), 200);
  };
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const openTooltip = (varKey: string, target: HTMLElement) => {
    cancelClose();
    setTooltip({ varKey, rect: target.getBoundingClientRect() });
  };

  const segments = value.split(VAR_SPLIT);

  return (
    <span className={`vi-wrap ${className ?? ''}`}>
      <input
        ref={inputRef}
        className={`vi-input ${masked ? 'vi-masked' : ''}`}
        type={masked ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={onBlur}
      />
      {!masked && (
        <div className="vi-overlay" ref={overlayRef} aria-hidden>
          {segments.map((segment, i) => {
            const match = segment.match(VAR_KEY);
            if (!match) return <span key={i}>{segment}</span>;
            const varKey = match[1]!;
            const known = resolved.has(varKey);
            return (
              <span
                key={i}
                className={`vi-var ${known ? 'known' : 'unknown'}`}
                onMouseEnter={(e) => openTooltip(varKey, e.currentTarget)}
                onMouseLeave={scheduleClose}
              >
                {segment}
              </span>
            );
          })}
        </div>
      )}
      {tooltip &&
        createPortal(
          <VariableTooltip
            varKey={tooltip.varKey}
            rect={tooltip.rect}
            resolved={resolved.get(tooltip.varKey)}
            collectionId={collectionId}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onClose={() => setTooltip(null)}
          />,
          document.body,
        )}
    </span>
  );
}

function VariableTooltip({
  varKey,
  rect,
  resolved,
  collectionId,
  onMouseEnter,
  onMouseLeave,
  onClose,
}: {
  varKey: string;
  rect: DOMRect;
  resolved: ResolvedVariable | undefined;
  collectionId?: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClose: () => void;
}) {
  const { activeEnvironmentId, environments, showNotice, bumpVariablesVersion } = useAppStore();
  const t = useT();
  const [draftValue, setDraftValue] = useState(resolved?.value ?? '');
  const [revealed, setRevealed] = useState(!resolved?.isSecret);
  const [saving, setSaving] = useState(false);

  // Tanımsız değişken aktif ortama, yoksa global'e eklenir
  const targetScope = resolved?.scope ?? (activeEnvironmentId ? 'environment' : 'global');
  const targetOwnerId = resolved?.ownerId ?? activeEnvironmentId ?? 'global';
  const scopeKey = SCOPE_LABELS[targetScope];
  const scopeLabel = scopeKey ? t(scopeKey) : targetScope;
  const scopeDetail =
    targetScope === 'environment'
      ? environments.find((e) => e.id === targetOwnerId)?.name
      : undefined;

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/variables', {
        scope: targetScope,
        ownerId: targetOwnerId,
        key: varKey,
        value: draftValue,
        isSecret: resolved?.isSecret ?? false,
        enabled: true,
      });
      bumpVariablesVersion();
      showNotice(
        resolved
          ? t('varTip.updated', { key: varKey })
          : t('varTip.added', { key: varKey, scope: scopeLabel.toLowerCase() }),
      );
      onClose();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const top = Math.min(rect.bottom + 6, window.innerHeight - 150);
  const left = Math.min(rect.left, window.innerWidth - 320);

  return (
    <div
      className="var-tooltip"
      style={{ top, left }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="var-tooltip-head">
        <code>{`{{${varKey}}}`}</code>
        <span className={`var-scope ${resolved ? '' : 'unknown'}`}>
          {resolved
            ? scopeDetail
              ? `${scopeLabel}: ${scopeDetail}`
              : scopeLabel
            : t('varTip.undefined')}
        </span>
      </div>
      <div className="var-tooltip-body">
        <input
          type={revealed ? 'text' : 'password'}
          value={draftValue}
          placeholder={t('vars.value.placeholder')}
          onChange={(e) => setDraftValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') onClose();
          }}
          autoFocus={!resolved}
        />
        {resolved?.isSecret && (
          <button className="icon-btn" title={revealed ? t('varTip.hide') : t('varTip.show')} onClick={() => setRevealed(!revealed)}>
            {revealed ? <EyeOff {...iconProps} /> : <Eye {...iconProps} />}
          </button>
        )}
        <button className="ghost-btn" disabled={saving} onClick={() => void save()}>
          {resolved ? t('common.save') : t('varTip.addToScope', { scope: scopeLabel })}
        </button>
      </div>
      {!resolved && (
        <p className="var-tooltip-hint">{t('varTip.undefinedHint')}</p>
      )}
    </div>
  );
}
