import React, { useLayoutEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder as editorPlaceholder, tooltips } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { createPqlCompletionSource, lengthLimit, MAX_EXPRESSION_LENGTH, pqlHighlighting, pqlLanguage } from './pqlLanguage.js';

const externalChange = Annotation.define();

export default function PqlEditor({ value, onChange, onRun, onFocus = () => {}, register, label, placeholder, completionIndex, isFilter = false, maxLength = MAX_EXPRESSION_LENGTH, consoleMode = false }) {
  const host = useRef(null), view = useRef(null), callbacks = useRef(null);
  const completion = useRef(new Compartment()), attributes = useRef(new Compartment());
  callbacks.current = { onChange, onRun, onFocus, register };

  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [
        lineNumbers(), history(), drawSelection(), highlightActiveLine(), EditorView.lineWrapping,
        pqlLanguage, pqlHighlighting, bracketMatching(), closeBrackets(), lengthLimit(maxLength),
        Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { callbacks.current.onRun?.(); return true; }, preventDefault: true, stopPropagation: true }])),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        editorPlaceholder(placeholder),
        tooltips({ parent: document.body }),
        completion.current.of(autocompletion({ override: [createPqlCompletionSource(completionIndex, isFilter)] })),
        attributes.current.of(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' })),
        EditorView.domEventHandlers({ focus: () => { callbacks.current.onFocus(); } }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalChange))) {
            callbacks.current.onChange(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          '&': { fontSize: '11px', border: '1px solid #c8d3cb', borderRadius: '5px', backgroundColor: '#fff' },
          '&.cm-focused': { outline: '2px solid #4683ba', outlineOffset: '1px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', maxHeight: '160px', overflow: 'auto', lineHeight: '1.55' },
          '.cm-content': { minHeight: '55px', padding: '6px 0' },
          '.cm-gutters': { backgroundColor: '#f4f7f3', color: '#8a978b', border: '0', borderRadius: '5px 0 0 5px' },
          '.cm-activeLine': { backgroundColor: '#edf4e959' },
          '.cm-tooltip': { fontFamily: 'ui-monospace, monospace', fontSize: '12px', border: '1px solid #b9c7bd', backgroundColor: '#fff', color: '#25372b' },
          '.cm-tooltip-autocomplete > ul': { maxWidth: 'min(600px, 90vw)', maxHeight: '200px' },
          '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#dcedcf', color: '#203b15' },
          '.cm-completionDetail': { color: '#596e5c', fontSize: '10px' },
        }),
      ] }),
    });
    view.current = editor;
    callbacks.current.register(editor);
    return () => { callbacks.current.register(null); editor.destroy(); view.current = null; };
    // The editor lives for this row's stable identity; updates below never recreate it.
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor.state.doc.toString() !== value) editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalChange.of(true),
    });
  }, [value]);
  useLayoutEffect(() => {
    view.current.dispatch({ effects: completion.current.reconfigure(autocompletion({ override: [createPqlCompletionSource(completionIndex, isFilter)] })) });
  }, [completionIndex, isFilter]);
  useLayoutEffect(() => {
    view.current.dispatch({ effects: attributes.current.reconfigure(EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' })) });
  }, [label]);

  return <div className={`pql-code-editor ${consoleMode ? 'pql-console-editor' : ''}`} ref={host}/>;
}
