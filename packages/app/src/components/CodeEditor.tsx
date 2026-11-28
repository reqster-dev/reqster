import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  keymap,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef, useState } from 'react';
import { basicSetup } from 'codemirror';
import type { CodeLanguage } from '../lib/formatters';
import { useResolvedVariables } from '../lib/resolvedVariables';
import { useTheme } from '../lib/theme';

const theme = EditorView.theme(
  {
    '&': {
      color: 'var(--text)',
      backgroundColor: 'var(--bg-input)',
      height: '100%',
      border: '1px solid var(--border-input)',
      borderRadius: 'var(--radius)',
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: 'var(--accent)',
    },
    '.cm-content': {
      fontFamily: 'Consolas, monospace',
      fontSize: '13px',
      caretColor: 'var(--text)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-input)',
      color: 'var(--text-dim)',
      border: 'none',
      borderRight: '1px solid var(--border)',
    },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--text)' },
    '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection-bg) !important' },
    '.cm-cursor': { borderLeftColor: 'var(--text)' },
    '.cm-panels': {
      backgroundColor: 'var(--bg-panel)',
      color: 'var(--text)',
    },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-overlay)',
      color: 'var(--text)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      boxShadow: 'var(--shadow)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--bg-elevated)',
      color: 'var(--text-dim)',
      border: '1px solid var(--border)',
    },
    '.cm-searchMatch': { backgroundColor: 'var(--search-match-bg)' },
    '.cm-var-known': {
      color: 'var(--green)',
      backgroundColor: 'var(--var-known-bg)',
      borderRadius: '3px',
    },
    '.cm-var-unknown': {
      color: 'var(--red)',
      backgroundColor: 'var(--var-unknown-bg)',
      borderRadius: '3px',
      textDecoration: 'underline dotted',
    },
    '.cm-placeholder': { color: 'var(--text-dim)' },
  },
);

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--purple)' },
  { tag: tags.string, color: 'var(--green)' },
  { tag: tags.number, color: 'var(--yellow)' },
  { tag: [tags.bool, tags.null], color: 'var(--orange)' },
  { tag: tags.comment, color: 'var(--text-dim)', fontStyle: 'italic' },
  { tag: tags.propertyName, color: 'var(--blue)' },
  { tag: tags.tagName, color: 'var(--blue)' },
  { tag: tags.attributeName, color: 'var(--yellow)' },
  { tag: tags.punctuation, color: 'var(--text-dim)' },
  { tag: tags.operator, color: 'var(--text)' },
]);

function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case 'json':
      return json();
    case 'xml':
      return xml();
    case 'javascript':
      return javascript();
    default:
      return [];
  }
}

// --- {{degisken}} vurgulaması: React state'i (resolvedKeys) bir StateEffect ile
// isolate/CodeMirror durumuna aktarılır; decoration'lar buna göre yeniden hesaplanır ---
const VAR_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

const setResolvedKeys = StateEffect.define<Set<string>>();
const resolvedKeysField = StateField.define<Set<string>>({
  create: () => new Set(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setResolvedKeys)) return effect.value;
    }
    return value;
  },
});

function buildVariableDecorations(view: EditorView): DecorationSet {
  const resolvedKeys = view.state.field(resolvedKeysField);
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    VAR_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = VAR_RE.exec(text))) {
      const start = from + match.index;
      const end = start + match[0].length;
      const known = resolvedKeys.has(match[1]!);
      builder.add(start, end, Decoration.mark({ class: known ? 'cm-var-known' : 'cm-var-unknown' }));
    }
  }
  return builder.finish();
}

const variableHighlightPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildVariableDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.transactions.some((tr) => tr.effects.some((e) => e.is(setResolvedKeys)))
      ) {
        this.decorations = buildVariableDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

function variableHighlightExtension(): Extension {
  return [resolvedKeysField, variableHighlightPlugin];
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: CodeLanguage;
  readOnly?: boolean;
  placeholder?: string;
  /** {{var}} vurgulaması için önceliklendirilmiş değişkenlerin çözüldüğü koleksiyon bağlamı */
  collectionId?: string;
  highlightVariables?: boolean;
  minHeightPx?: number;
  className?: string;
}

/**
 * CodeMirror 6 tabanlı hafif kod editörü: satır numaraları, sözdizimi vurgusu
 * (JSON/XML/JavaScript), katlama, parantez eşleştirme — `basicSetup` üzerinden.
 * Reqster'a özgü `{{var}}` vurgulaması ayrı bir ViewPlugin ile eklenir.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  placeholder,
  collectionId,
  highlightVariables = false,
  minHeightPx = 120,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Dışarıdan (value prop'u) gelen senkron dispatch sırasında true: bu değişiklik kullanıcıdan
  // gelmediği için onChange'e yansıtılmaz (aksi hâlde sekme değişimi taslağı "dirty" yapıyordu)
  const syncingRef = useRef(false);

  const [languageCompartment] = useState(() => new Compartment());
  const [readOnlyCompartment] = useState(() => new Compartment());
  // Renkler CSS token'larından gelir; bu bayrak yalnızca CodeMirror'ın kendi varsayılan
  // (basicSetup) stillerinin açık/koyu varyantını seçer
  const [darkCompartment] = useState(() => new Compartment());
  const isDark = useTheme() === 'dark';

  const resolved = useResolvedVariables(collectionId);

  // Editör yalnızca mount'ta bir kez kurulur; sonraki prop değişimleri aşağıdaki
  // efektlerle Compartment/StateEffect üzerinden senkronize edilir (cursor/undo history korunur).
  useEffect(() => {
    if (!hostRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !syncingRef.current) {
        onChangeRef.current?.(update.state.doc.toString());
      }
    });

    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        languageCompartment.of(languageExtension(language)),
        readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
        // `editable` false yapılmaz: içerik odaklanamaz, Ctrl+A tüm sayfayı seçer. Salt-okunur
        // durumda da odaklanabilir kalır (Ctrl+A/kopyala yalnızca editör içeriğine uygulanır),
        // düzenlemeyi `EditorState.readOnly` engeller.
        theme,
        darkCompartment.of(EditorView.darkTheme.of(isDark)),
        syntaxHighlighting(highlightStyle),
        highlightVariables ? variableHighlightExtension() : [],
        EditorView.lineWrapping,
        placeholder ? placeholderExtension(placeholder) : [],
        updateListener,
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dışarıdan gelen value değişikliği (sekme değişimi, Beautify butonu) editöre yansıtılır;
  // editörün kendi onChange'inden geri gelen aynı değerde dispatch atlanır (cursor korunur).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      syncingRef.current = true;
      try {
        view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
      } finally {
        syncingRef.current = false;
      }
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: languageCompartment.reconfigure(languageExtension(language)) });
  }, [language, languageCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
    });
  }, [readOnly, readOnlyCompartment]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: darkCompartment.reconfigure(EditorView.darkTheme.of(isDark)) });
  }, [isDark, darkCompartment]);

  useEffect(() => {
    if (!highlightVariables) return;
    viewRef.current?.dispatch({ effects: setResolvedKeys.of(new Set(resolved.keys())) });
  }, [resolved, highlightVariables]);

  return (
    <div
      ref={hostRef}
      className={`code-editor-host ${className ?? ''}`}
      style={{ minHeight: minHeightPx }}
    />
  );
}
