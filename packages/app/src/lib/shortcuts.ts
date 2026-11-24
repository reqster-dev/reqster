/**
 * Global klavye kısayolları. Tek dinleyici `window` üzerinde CAPTURE fazında çalışır:
 * böylece odak CodeMirror'dayken bile olay editöre ulaşmadan yakalanır (CodeMirror'ın
 * kendi Mod-Enter bağı devreye girmez) ve tarayıcı varsayılanı (Ctrl+S kaydet diyaloğu)
 * `preventDefault` ile engellenir.
 *
 * Sekme kısayolları: masaüstü kabuğunda Postman'daki gibi Ctrl+T / Ctrl+W (Alt+T / Alt+W de
 * çalışmaya devam eder); tarayıcıda yalnızca Alt+T / Alt+W, çünkü Ctrl+T / Ctrl+W tarayıcıya
 * ayrılıdır ve sayfa bunları yakalayamaz. Kabukta tarayıcıya özgü kısayolların (yenile, geri,
 * yazdır…) bastırılması ayrı iştir: `lib/desktopGuard.ts`.
 */

import { isDesktopShell } from './download';
import type { MessageKey } from './i18n';

export type ShortcutId = 'send' | 'save' | 'saveAs' | 'newTab' | 'closeTab' | 'help';

export interface ShortcutInfo {
  id: ShortcutId;
  /** Kullanıcıya gösterilen tuş kombinasyonları (alternatifler ayrı öğe) */
  keys: string[];
  /** Kullanıcıya gösterilen açıklamanın sözlük anahtarı (`t(labelKey)`) */
  labelKey: MessageKey;
}

/** Sekme kısayollarının kullanıcıya gösterilen değiştirici tuşu */
const TAB_MOD = isDesktopShell() ? 'Ctrl' : 'Alt';
export const NEW_TAB_KEYS = `${TAB_MOD}+T`;
export const CLOSE_TAB_KEYS = `${TAB_MOD}+W`;

export const SHORTCUTS: ShortcutInfo[] = [
  { id: 'send', keys: ['Ctrl+Enter'], labelKey: 'shortcuts.send' },
  { id: 'save', keys: ['Ctrl+S'], labelKey: 'shortcuts.save' },
  { id: 'saveAs', keys: ['Ctrl+Shift+S'], labelKey: 'shortcuts.saveAs' },
  { id: 'newTab', keys: [NEW_TAB_KEYS], labelKey: 'shortcuts.newTab' },
  { id: 'closeTab', keys: [CLOSE_TAB_KEYS], labelKey: 'shortcuts.closeTab' },
  { id: 'help', keys: ['Ctrl+/', '?'], labelKey: 'shortcuts.help' },
];

export type ShortcutActions = Record<ShortcutId, () => void>;

/** macOS'ta Cmd, Ctrl gibi kabul edilir */
function isMod(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/** Harf tuşu: `key` düzenden bağımsız değilse (macOS'ta Alt+T → "†") fiziksel `code`'a bakılır */
function isLetter(e: KeyboardEvent, letter: string): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function matches(e: KeyboardEvent): ShortcutId | null {
  const mod = isMod(e);
  if (mod && !e.altKey && e.key === 'Enter') return 'send';
  if (mod && !e.altKey && isLetter(e, 's')) return e.shiftKey ? 'saveAs' : 'save';
  if (e.altKey && !mod && !e.shiftKey && isLetter(e, 't')) return 'newTab';
  if (e.altKey && !mod && !e.shiftKey && isLetter(e, 'w')) return 'closeTab';
  if (isDesktopShell() && mod && !e.altKey && !e.shiftKey && isLetter(e, 't')) return 'newTab';
  if (isDesktopShell() && mod && !e.altKey && !e.shiftKey && isLetter(e, 'w')) return 'closeTab';
  if (mod && !e.altKey && (e.key === '/' || e.code === 'Slash')) return 'help';
  if (!mod && !e.altKey && e.key === '?' && !isEditableTarget(e.target)) return 'help';
  return null;
}

/**
 * Dinleyiciyi kurar, kaldırma fonksiyonunu döner. `isBlocked` true dönerken (bir diyalog/modal
 * açıkken) kısayollar yok sayılır; yalnızca Ctrl+S'nin tarayıcı diyaloğu yine engellenir
 * (kabukta hepsinin varsayılanı engellenir).
 */
export function installShortcuts(actions: ShortcutActions, isBlocked: () => boolean): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    const id = matches(e);
    if (!id) return;
    if (isBlocked()) {
      if (id === 'save' || id === 'saveAs' || isDesktopShell()) e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // Basılı tutmak art arda sekme açmasın / istek göndermesin
    if (e.repeat) return;
    actions[id]();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
