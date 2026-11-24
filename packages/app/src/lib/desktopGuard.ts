/**
 * Masaüstü kabuğunda pencere bir tarayıcı gibi davranmasın: WebView'in tarayıcıya özgü kısayolları
 * (yenile, geri/ileri, yazdır, sayfada bul, kaynağı gör…), farenin geri/ileri düğmeleri ve
 * varsayılan sağ tık menüsü ("Geri", "Yenile", "Yazdır") bastırılır. Geri gitmek pencereyi açılış
 * ekranına, yenilemek kaydedilmemiş sekme taslaklarının kaybına götürüyordu.
 *
 * Tarayıcıda (geliştirme, taşınabilir mod) hiçbir şey kurulmaz: orada bunlar kullanıcının beklediği
 * tarayıcı davranışıdır. Uygulamanın kendi kısayolları `lib/shortcuts.ts`'tedir.
 */

import { isDesktopShell } from './download';

const IS_MAC = /mac/i.test(navigator.platform);

/** Metin düzenlenen yer: sağ tık menüsü (kes/kopyala/yapıştır) burada kalır */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return !target.disabled;
  // Onay kutusu, düğme gibi girdilerde metin menüsünün anlamı yok
  return target instanceof HTMLInputElement && !target.disabled && /^(text|search|url|password|number|email|tel)$/.test(target.type);
}

/** Kod editörü kendi arama panelini (Ctrl+F / Ctrl+G / F3) açar; o tuşlar orada editöre bırakılır */
function inCodeEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-editor') !== null;
}

function isBrowserShortcut(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  // Yenile
  if (e.key === 'F5' || (mod && !e.altKey && key === 'r')) return true;
  // Geri / ileri (macOS'ta Alt+ok sözcük atlamadır, gezinme Cmd+[ / Cmd+])
  if (e.key === 'BrowserBack' || e.key === 'BrowserForward') return true;
  if (!IS_MAC && e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return true;
  if (IS_MAC && e.metaKey && (e.key === '[' || e.key === ']')) return true;
  // Sayfada bul
  if ((e.key === 'F3' || (mod && !e.altKey && (key === 'f' || key === 'g'))) && !inCodeEditor(e.target)) return true;
  // Yazdır, kaynağı gör, indirilenler, dosya aç, imleçle gezinme
  if (mod && !e.altKey && !e.shiftKey && (key === 'p' || key === 'u' || key === 'j' || key === 'o')) return true;
  if (e.key === 'F7') return true;
  return false;
}

/** Bir kez kurulur (`main.tsx`); kabuk dışında etkisizdir */
export function installDesktopGuard(): void {
  if (!isDesktopShell()) return;

  // Capture fazı: olay hiçbir bileşene ulaşmadan varsayılanı engellenir. Yayılım durdurulmaz;
  // uygulamanın kendi kısayolları bu tuşların hiçbirini kullanmıyor.
  window.addEventListener(
    'keydown',
    (e) => {
      if (isBrowserShortcut(e)) e.preventDefault();
    },
    true,
  );

  window.addEventListener(
    'contextmenu',
    (e) => {
      if (!isEditable(e.target)) e.preventDefault();
    },
    true,
  );

  // Farenin yan düğmeleri (3 = geri, 4 = ileri)
  const blockSideButtons = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  window.addEventListener('mousedown', blockSideButtons, true);
  window.addEventListener('mouseup', blockSideButtons, true);
  window.addEventListener('auxclick', blockSideButtons, true);
}
