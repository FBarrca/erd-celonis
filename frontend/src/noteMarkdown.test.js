import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { noteMarkdown } from './noteMarkdown.js';
import { MAX_NOTE_LENGTH } from './stickyNotes.js';

test('note editor recognizes Markdown including task lists and preserves source text', () => {
  const doc = '# Join notes\n\n**Required** and *optional* with `ID`.\n\n[Docs](https://example.com)\n\n- [ ] Check join\n\n~~Done~~';
  const state = EditorState.create({ doc, extensions: noteMarkdown });
  const tree = syntaxTree(state).toString();
  for (const name of ['ATXHeading1', 'StrongEmphasis', 'Emphasis', 'InlineCode', 'Link', 'Task', 'Strikethrough']) {
    assert.ok(tree.includes(name), `${name} recognized: ${tree}`);
  }
  assert.equal(state.doc.toString(), doc);
});

test('Markdown editing retains the note length limit and permits deletion at the limit', () => {
  const state = EditorState.create({ doc: 'x'.repeat(MAX_NOTE_LENGTH), extensions: noteMarkdown });
  assert.equal(state.update({ changes: { from: state.doc.length, insert: 'too much' } }).state.doc.length, MAX_NOTE_LENGTH);
  assert.equal(state.update({ changes: { from: 0, to: 1 } }).state.doc.length, MAX_NOTE_LENGTH - 1);
});
