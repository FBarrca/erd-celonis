import React, { useLayoutEffect, useRef } from 'react';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, keymap, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { noteMarkdown } from './noteMarkdown.js';

const externalChange = Annotation.define();

export default function NoteEditor({ value, onChange, autoFocus }) {
  const host = useRef(null), view = useRef(null), callback = useRef(onChange);
  callback.current = onChange;

  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({ doc: value, extensions: [
        noteMarkdown, history(), drawSelection(), EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        placeholder('Write a note… Markdown supported'),
        EditorView.contentAttributes.of({ 'aria-label': 'Note text', 'aria-multiline': 'true', spellcheck: 'true' }),
        EditorView.updateListener.of(update => {
          if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalChange))) {
            callback.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px', backgroundColor: 'transparent', color: '#514421' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': { overflow: 'auto', fontFamily: '"Segoe UI", sans-serif', lineHeight: '1.55' },
          '.cm-content': { padding: '12px 0', minHeight: '100%', caretColor: '#514421' },
          '.cm-line': { padding: '0 14px' },
          '.cm-placeholder': { color: '#8d7b49' },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#d6bc6970' },
          '.cm-cursor': { borderLeftColor: '#514421' },
        }),
      ] }),
    });
    view.current = editor;
    if (autoFocus) editor.focus();
    return () => { editor.destroy(); view.current = null; };
    // Keep selection and undo history while React Flow updates the note data.
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (editor.state.doc.toString() !== value) editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: value }, annotations: externalChange.of(true),
    });
  }, [value]);

  return <div ref={host} className="sticky-note__editor nodrag nopan nowheel"
    onKeyDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} />;
}
