import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { MAX_NOTE_LENGTH } from './stickyNotes.js';

export const noteMarkdown = [
  markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: tags.heading, color: '#755118', fontWeight: '700' },
    { tag: tags.strong, fontWeight: '700' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: [tags.link, tags.url], color: '#28618a', textDecoration: 'underline' },
    { tag: tags.monospace, color: '#7c3c31', fontFamily: 'ui-monospace, monospace', backgroundColor: '#eddda4' },
    { tag: tags.quote, color: '#777047', fontStyle: 'italic' },
    { tag: [tags.processingInstruction, tags.contentSeparator], color: '#927227' },
  ])),
  EditorState.transactionFilter.of(transaction => transaction.docChanged
    && transaction.newDoc.length > MAX_NOTE_LENGTH
    && transaction.newDoc.length > transaction.startState.doc.length ? [] : transaction),
];
