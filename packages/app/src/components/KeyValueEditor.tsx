import type { KeyValueItem } from '@reqster/shared';
import { FolderOpen, ListChecks, Rows3, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { isDesktopShell } from '../lib/download';
import { useT } from '../lib/i18n';
import { iconProps } from '../lib/icons';
import { useAppStore } from '../stores/appStore';
import { VariableInput } from './VariableInput';

interface Props {
  items: KeyValueItem[];
  onChange: (items: KeyValueItem[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Değişken tooltip'inin koleksiyon kapsamını çözebilmesi için */
  collectionId?: string;
  /** form-data: satır başına Metin/Dosya türü seçici */
  allowFile?: boolean;
}

/** Toplu düzenleme metni: her satır `anahtar:değer`, devre dışı satırın başında `//` (Postman biçimi). */
function itemsToBulk(items: KeyValueItem[]): string {
  return items.map((i) => `${i.enabled ? '' : '//'}${i.key}:${i.value}`).join('\n');
}

/** Metinde tür yazılmaz: aynı anahtarlı önceki satır dosya alanıysa tür korunur (form-data) */
function bulkToItems(text: string, previous: KeyValueItem[]): KeyValueItem[] {
  const fileKeys = new Set(previous.filter((i) => i.type === 'file').map((i) => i.key));
  const items: KeyValueItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    let enabled = true;
    if (line.trimStart().startsWith('//')) {
      enabled = false;
      line = line.trimStart().slice(2);
    }
    if (line.trim() === '') continue;
    const idx = line.indexOf(':');
    const key = idx === -1 ? line : line.slice(0, idx);
    const value = idx === -1 ? '' : line.slice(idx + 1);
    const item: KeyValueItem = { key: key.trim(), value: value.trim(), enabled };
    if (fileKeys.has(item.key)) item.type = 'file';
    items.push(item);
  }
  return items;
}

/**
 * Anahtar/değer listesi. Altta her zaman boş bir "hayalet" satır durur; ona yazılmaya
 * başlanınca satır gerçek olur ve altına yenisi gelir (Postman gibi). Satırlar bilinçli
 * olarak index ile key'lenir: hayalet satır gerçeğe dönüştüğünde aynı index'te kalır,
 * React DOM öğesini yeniden kullanır ve yazarken odak kaybolmaz. Gerçek satır boşalsa da
 * kendiliğinden silinmez; yalnızca × ile silinir.
 */
export function KeyValueEditor({ items, onChange, keyPlaceholder, valuePlaceholder, collectionId, allowFile }: Props) {
  const t = useT();
  const [bulk, setBulk] = useState<string | null>(null);
  const update = (index: number, patch: Partial<KeyValueItem>) => {
    if (index === items.length) {
      onChange([...items, { key: '', value: '', enabled: true, ...patch }]);
      return;
    }
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index));

  // Kabuktaki dosya diyaloğu dakikalarca açık kalabilir: dönüşte en güncel liste üzerine yazılır
  const [pickingIndex, setPickingIndex] = useState<number | null>(null);
  const latest = useRef({ items, onChange });
  useEffect(() => {
    latest.current = { items, onChange };
  });
  const pickFile = async (index: number) => {
    setPickingIndex(index);
    try {
      const { path } = await api.post<{ path: string | null }>('/shell/pick-file');
      if (path !== null) {
        const current = latest.current;
        current.onChange(current.items.map((item, i) => (i === index ? { ...item, value: path } : item)));
      }
    } catch (err) {
      useAppStore.getState().showNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingIndex(null);
    }
  };
  const canPick = allowFile && isDesktopShell();

  const rows: Array<KeyValueItem | null> = [...items, null];

  if (bulk !== null) {
    return (
      <div className="kv-editor">
        <div className="kv-bulk-bar">
          <button
            className="ghost-btn"
            onClick={() => {
              onChange(bulkToItems(bulk, items));
              setBulk(null);
            }}
          >
            <Rows3 {...iconProps} /> {t('kv.bulk.back')}
          </button>
        </div>
        <textarea
          className="kv-bulk"
          value={bulk}
          spellCheck={false}
          placeholder={t('kv.bulk.placeholder')}
          onChange={(e) => {
            setBulk(e.target.value);
            onChange(bulkToItems(e.target.value, items));
          }}
        />
      </div>
    );
  }

  return (
    <div className="kv-editor">
      <div className="kv-bulk-bar">
        <button className="ghost-btn" onClick={() => setBulk(itemsToBulk(items))}>
          <ListChecks {...iconProps} /> {t('kv.bulk.edit')}
        </button>
      </div>
      {rows.map((item, i) => {
        const ghost = item === null;
        return (
          <div className={`kv-row ${ghost ? 'kv-ghost' : ''}`} key={i}>
            <input
              type="checkbox"
              checked={item?.enabled ?? false}
              disabled={ghost}
              tabIndex={ghost ? -1 : undefined}
              aria-hidden={ghost || undefined}
              onChange={(e) => update(i, { enabled: e.target.checked })}
              title={t('vars.enabled')}
            />
            <input
              className="kv-key"
              value={item?.key ?? ''}
              placeholder={keyPlaceholder ?? t('vars.key.placeholder')}
              onChange={(e) => update(i, { key: e.target.value })}
            />
            {allowFile && (
              <select
                value={item?.type ?? 'text'}
                title={t('kv.type.title')}
                disabled={ghost}
                tabIndex={ghost ? -1 : undefined}
                aria-hidden={ghost || undefined}
                onChange={(e) => update(i, { type: e.target.value as 'text' | 'file' })}
              >
                <option value="text">{t('kv.type.text')}</option>
                <option value="file">{t('kv.type.file')}</option>
              </select>
            )}
            <VariableInput
              className="kv-value"
              value={item?.value ?? ''}
              placeholder={
                item?.type === 'file' ? t('kv.file.placeholder') : (valuePlaceholder ?? t('kv.value.placeholder'))
              }
              onChange={(value) => update(i, { value })}
              collectionId={collectionId}
            />
            {canPick && item?.type === 'file' && (
              <button
                className="icon-btn"
                onClick={() => void pickFile(i)}
                disabled={pickingIndex !== null}
                title={t('kv.file.pick')}
                aria-label={t('kv.file.pick')}
              >
                <FolderOpen {...iconProps} />
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => remove(i)}
              title={t('kv.removeRow')}
              disabled={ghost}
              tabIndex={ghost ? -1 : undefined}
              aria-hidden={ghost || undefined}
            >
              <X {...iconProps} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
