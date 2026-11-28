import type { AppVersionInfo, Settings, SettingsPatch, UiLanguage } from '@reqster/shared';
import { Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { T } from '../../components/T';
import { setLanguage, useLanguage, useT } from '../../lib/i18n';
import { iconProps } from '../../lib/icons';
import { dialog } from '../../stores/dialogStore';

/**
 * Uygulama ayarları: başlıktaki dişli (Settings) simge butonu, ortak `DialogFrame` içinde açılan bir
 * diyalog. Store'a bağlı değildir; kendi içinde `GET/PATCH /api/settings` ile çalışır. Her alan
 * değişince anında kaydedilir; Esc / overlay / kapat (X) ile kapanır.
 */
export function SettingsMenu() {
  const t = useT();
  return (
    <button className="ghost-btn icon-only" onClick={showSettings} title={t('settings.title')} aria-label={t('settings.title')}>
      <SettingsIcon {...iconProps} />
    </button>
  );
}

export function showSettings(): void {
  void dialog.custom<void>({
    title: <T k="settings.title" />,
    cancelValue: undefined,
    className: 'settings-dialog',
    render: (close) => (
      <>
        <div className="dialog-body settings-body">
          <SettingsForm />
        </div>
        <div className="modal-footer">
          <button className="send-btn" data-autofocus onClick={() => close()}>
            <T k="common.close" />
          </button>
        </div>
      </>
    ),
  });
}

const LANGUAGE_OPTIONS: UiLanguage[] = ['auto', 'tr', 'en'];

function SettingsForm() {
  const t = useT();
  // Dil seçicinin değeri i18n durumundan gelir: sunucu yanıtı gelmeden önce de doğru gösterir
  const { setting: languageSetting } = useLanguage();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<AppVersionInfo>('/version')
      .then((info) => setVersion(info.version))
      .catch(() => setVersion(null));
    api
      .get<Settings>('/settings')
      .then(setSettings)
      .catch((err: Error) => setError(err.message));
  }, []);

  // İyimser güncelleme: onay kutusu tıklamada hemen değişir; sunucu reddederse geri alınır
  const save = async (patch: SettingsPatch) => {
    setError(null);
    const previous = settings;
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      setSettings(await api.patch<Settings>('/settings', patch));
    } catch (err) {
      setSettings(previous);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveNumber = (key: 'network.timeout_ms' | 'network.max_redirects', raw: string) => {
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    void save({ [key]: n });
  };

  if (!settings) return <p className="hint">{error ?? t('common.loading')}</p>;

  return (
    <div className="settings-form">
      <h3>{t('settings.general')}</h3>
      <label className="kv-row">
        <span className="kv-key">{t('settings.language')}</span>
        <select
          className="kv-value"
          value={languageSetting}
          // Anında uygulanır ve tema gibi `lib/uiPrefs.ts` üzerinden sunucuya yazılır
          onChange={(e) => setLanguage(e.target.value as UiLanguage)}
        >
          {LANGUAGE_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {t(`settings.language.${value}`)}
            </option>
          ))}
        </select>
      </label>

      <h3>{t('settings.network')}</h3>
      <label className="kv-row">
        <input
          type="checkbox"
          checked={settings['network.verify_tls']}
          onChange={(e) => void save({ 'network.verify_tls': e.target.checked })}
        />
        <span>{t('settings.tls.label')}</span>
      </label>
      <p className="hint">
        {t('settings.tls.hintBefore')}
        <code>NODE_EXTRA_CA_CERTS</code>
        {t('settings.tls.hintAfter')}
      </p>
      {!settings['network.verify_tls'] && <p className="hint warn">{t('settings.tls.off')}</p>}

      <label className="kv-row">
        <input
          type="checkbox"
          checked={settings['network.reuse_connections']}
          onChange={(e) => void save({ 'network.reuse_connections': e.target.checked })}
        />
        <span>{t('settings.reuse.label')}</span>
      </label>
      <p className="hint">{t('settings.reuse.hint')}</p>

      <label className="kv-row">
        <span className="kv-key">{t('settings.timeout')}</span>
        <input
          className="kv-value"
          type="number"
          min={0}
          max={600000}
          step={1000}
          defaultValue={settings['network.timeout_ms']}
          onBlur={(e) => saveNumber('network.timeout_ms', e.target.value)}
        />
      </label>
      <p className="hint">{t('settings.timeout.hint')}</p>
      <label className="kv-row">
        <span className="kv-key">{t('settings.maxRedirects')}</span>
        <input
          className="kv-value"
          type="number"
          min={0}
          max={50}
          defaultValue={settings['network.max_redirects']}
          onBlur={(e) => saveNumber('network.max_redirects', e.target.value)}
        />
      </label>

      <h3>{t('settings.updates')}</h3>
      {version && (
        <p className="settings-version" data-testid="app-version">
          {t('settings.updates.installed', { version })}
        </p>
      )}
      <p className="hint">
        {t('settings.updates.hintBefore')}
        <code>reqster.dev/updates</code>
        {t('settings.updates.hintAfter')}
      </p>
      {error && <p className="hint warn">{error}</p>}
    </div>
  );
}
