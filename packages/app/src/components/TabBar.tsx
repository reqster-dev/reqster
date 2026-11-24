import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import { iconProps } from '../lib/icons';
import { CLOSE_TAB_KEYS, NEW_TAB_KEYS } from '../lib/shortcuts';
import { useAppStore } from '../stores/appStore';

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, newTab, moveTab } = useAppStore();
  const t = useT();
  // Sürükleme durumu: taşınan sekme ve bırakma göstergesi (hedef + yan)
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);

  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };

  return (
    <div className="tabbar">
      {tabs.map((tab) => {
        const dropClass =
          drop && drop.id === tab.id && dragId !== tab.id ? (drop.after ? 'drop-after' : 'drop-before') : '';
        return (
          <div
            key={tab.id}
            className={`tabbar-item ${tab.id === activeTabId ? 'active' : ''} ${dragId === tab.id ? 'dragging' : ''} ${dropClass}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              // Firefox/WebKit sürüklemeyi başlatmak için veri ister
              e.dataTransfer.setData('text/plain', tab.id);
              setDragId(tab.id);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              if (drop?.id !== tab.id || drop.after !== after) setDrop({ id: tab.id, after });
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && drop) moveTab(dragId, drop.id, drop.after);
              endDrag();
            }}
            onDragEnd={endDrag}
            onClick={() => setActiveTab(tab.id)}
            onAuxClick={(e) => {
              // Orta tık ile kapatma
              if (e.button === 1) void closeTab(tab.id);
            }}
            title={tab.draft.url || tab.draft.name}
          >
            <span className={`method-tag method-${tab.draft.method}`}>{tab.draft.method}</span>
            <span className="tabbar-label">
              {tab.draft.name}
              {!tab.draft.requestId && <span className="tabbar-unsaved"> {t('tabs.unsaved')}</span>}
            </span>
            {tab.dirty && <span className="tabbar-dirty" title={t('common.unsavedChanges')} />}
            <button
              className="icon-btn"
              title={t('tabs.close', { keys: CLOSE_TAB_KEYS })}
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
            >
              <X {...iconProps} />
            </button>
          </div>
        );
      })}
      <button className="tabbar-new" title={t('tabs.new', { keys: NEW_TAB_KEYS })} onClick={() => newTab()}>
        <Plus {...iconProps} />
      </button>
    </div>
  );
}
