import { isDesktopShell } from '../lib/download';
import { useT } from '../lib/i18n';
import { SHORTCUTS } from '../lib/shortcuts';
import { dialog } from '../stores/dialogStore';
import { T } from './T';

/** Kısayol listesi diyaloğu (başlık çubuğundaki "?" ve Ctrl+/ açar) */
export function showShortcutsHelp(): void {
  void dialog.custom<void>({
    title: <T k="shortcuts.title" />,
    cancelValue: undefined,
    className: 'shortcuts-dialog',
    render: (close) => <ShortcutsHelpBody close={close} />,
  });
}

function ShortcutsHelpBody({ close }: { close: () => void }) {
  const t = useT();
  return (
    <>
      <div className="dialog-body">
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.id}>
                <td className="shortcuts-keys">
                  {s.keys.map((k, i) => (
                    <span key={k}>
                      {i > 0 && <span className="shortcuts-or"> {t('shortcuts.or')} </span>}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </td>
                <td>{t(s.labelKey)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint shortcuts-note">{t(isDesktopShell() ? 'shortcuts.noteDesktop' : 'shortcuts.note')}</p>
      </div>
      <div className="modal-footer">
        <button className="send-btn" data-autofocus onClick={() => close()}>
          {t('common.ok')}
        </button>
      </div>
    </>
  );
}
