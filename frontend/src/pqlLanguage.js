import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { snippetCompletion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { pqlReference } from './queryDrafts.js';

export const MAX_EXPRESSION_LENGTH = 8192;
const keywords = ['TABLE', 'AS', 'LIMIT', 'FILTER', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'DISTINCT', 'IN', 'LIKE', 'IS'];
const keywordSet = new Set(keywords);

// Shared by the highlighter and completion context scanner. Double quotes are
// identifiers; single quotes are PQL strings, including backslash escapes.
function nextToken(text, from, state) {
  let end = from;
  if (!state.mode) {
    const rest = text.slice(from);
    const space = /^\s+/.exec(rest);
    if (space) return { to: from + space[0].length, type: null };
    if (rest.startsWith('--')) return { to: text.indexOf('\n', from) < 0 ? text.length : text.indexOf('\n', from), type: 'comment' };
    if (rest.startsWith('/*')) { state.mode = 'comment'; end += 2; }
    else if (text[from] === '"' || text[from] === "'") { state.mode = text[from]; end++; }
    else {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
      if (number) return { to: from + number[0].length, type: 'number' };
      const word = /^[\p{L}_$][\p{L}\p{N}_$]*/u.exec(rest);
      if (word) {
        const to = from + word[0].length;
        return { to, type: keywordSet.has(word[0].toUpperCase()) ? 'keyword' : /^\s*\(/.test(text.slice(to)) ? 'function' : 'variableName' };
      }
      return { to: from + 1, type: /[+*/%=<>!|&^-]/.test(text[from]) ? 'operator' : 'punctuation' };
    }
  }
  const mode = state.mode;
  if (mode === 'comment') {
    const close = text.indexOf('*/', end);
    if (close < 0) return { to: text.length, type: 'comment' };
    state.mode = null;
    return { to: close + 2, type: 'comment' };
  }
  while (end < text.length) {
    if (mode === "'" && text[end] === '\\') { end = Math.min(end + 2, text.length); continue; }
    if (text[end++] === mode) {
      if (mode === '"' && text[end] === '"') { end++; continue; }
      state.mode = null;
      break;
    }
  }
  return { to: end, type: mode === '"' ? 'variableName' : 'string' };
}

export function tokenizePql(text) {
  const tokens = [], state = { mode: null };
  for (let from = 0; from < text.length;) {
    const token = nextToken(text, from, state);
    tokens.push({ ...token, from, text: text.slice(from, token.to), closed: !state.mode });
    from = token.to;
  }
  return tokens;
}

export const pqlLanguage = StreamLanguage.define({
  startState: () => ({ mode: null }),
  token(stream, state) {
    const token = nextToken(stream.string, stream.pos, state);
    stream.pos = token.to;
    return token.type;
  },
  tokenTable: { function: tags.function(tags.variableName) },
  languageData: { closeBrackets: { brackets: ['(', '[', '"', "'"] } },
});

export const pqlHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: '#8054a1', fontWeight: '600' },
  { tag: tags.function(tags.variableName), color: '#005a99' },
  { tag: tags.variableName, color: '#176354' },
  { tag: tags.string, color: '#9c4d16' },
  { tag: tags.number, color: '#245fba' },
  { tag: tags.operator, color: '#8054a1' },
  { tag: tags.comment, color: '#738078', fontStyle: 'italic' },
]));

// Shared by typing, paste, completion, and the separate schema search helper.
export const lengthLimit = maximum => EditorState.transactionFilter.of(transaction =>
  transaction.docChanged && transaction.newDoc.length > maximum
    && transaction.newDoc.length > transaction.startState.doc.length ? [] : transaction);
export const expressionLengthLimit = lengthLimit(MAX_EXPRESSION_LENGTH);

const functionDefinitions = [
  ['COUNT_TABLE', 'COUNT_TABLE(${table})', 'Count rows in a table.'],
  ['COUNT', 'COUNT(${expression})', 'Count non-null values.'],
  ['SUM', 'SUM(${expression})', 'Sum numeric values.'],
  ['AVG', 'AVG(${expression})', 'Average numeric values.'],
  ['MIN', 'MIN(${expression})', 'Minimum value.'],
  ['MAX', 'MAX(${expression})', 'Maximum value.'],
  ['PU_COUNT', 'PU_COUNT(${target_table}, ${source_column})', 'Count source values for each target-table row.'],
  ['PU_SUM', 'PU_SUM(${target_table}, ${source_column})', 'Sum source values for each target-table row.'],
  ['CASE WHEN', 'CASE WHEN ${condition} THEN ${value} ELSE ${fallback} END', 'Conditional expression.'],
];
const functions = functionDefinitions.map(([label, template, info]) => snippetCompletion(template, { label, type: 'function', info }));
const filterSnippet = snippetCompletion('FILTER ${condition};', { label: 'FILTER', type: 'keyword', info: 'Restrict the query to matching rows.' });

const decodeIdentifier = text => text.startsWith('"') ? text.slice(1).replace(/"$/, '').replaceAll('""', '"') : text;
const nameOf = table => String(table.alias || table.name || table.table_id || table.id);
const quote = name => `"${name.replaceAll('"', '""')}"`;
const indexed = (option, search) => ({ option, search: search.toLocaleLowerCase() });

export function createPqlCompletionIndex(tables) {
  const all = [], byTable = new Map();
  for (const table of tables) {
    const name = nameOf(table);
    const columns = (table.columns || []).map(column => indexed({
      label: column.name, type: 'property', detail: `${name}${column.type ? ` · ${column.type}` : ''}`,
      apply: quote(column.name),
    }, column.name));
    byTable.set(name, columns);
    all.push(indexed({ label: name, type: 'class', detail: 'Table', apply: pqlReference({ table }) }, `${name} ${table.name || ''}`));
    for (const column of table.columns || []) all.push(indexed({
      label: `${name}.${column.name}`, type: 'property', detail: column.type ? String(column.type) : 'Column',
      apply: pqlReference({ table, column: column.name }),
    }, `${name} ${table.name || ''} ${column.name}`));
  }
  return { all, byTable };
}

export function createPqlCompletionSource(index, isFilter = false) {
  const general = [...index.all, ...functions.map(option => indexed(option, option.label)),
    ...keywords.filter(word => word !== 'FILTER').map(label => indexed({ label, type: 'keyword' }, label)),
    ...(isFilter ? [indexed(filterSnippet, 'FILTER')] : [])];
  return context => {
    const text = context.state.doc.toString(), pos = context.pos;
    const tokens = tokenizePql(text);
    const token = tokens.find(item => item.from < pos && pos <= item.to);
    if (token?.type === 'string' || token?.type === 'comment') return null;
    const identifier = token && ['variableName', 'keyword', 'function'].includes(token.type) ? token : null;
    const from = identifier?.from ?? pos;
    // An unfinished quote must not consume the rest of a multiline script.
    const newline = text.indexOf('\n', pos);
    const to = identifier && !identifier.closed && newline >= 0 ? Math.min(identifier.to, newline) : identifier?.to ?? pos;
    const before = tokens.filter(item => item.to <= from && item.type && item.type !== 'comment');
    const dot = before.at(-1)?.text === '.';
    const tableToken = dot ? before.at(-2) : null;
    let candidates = general;
    if (dot) {
      const name = decodeIdentifier(tableToken?.text || '');
      // Exact names win when a model has aliases differing only in case.
      candidates = index.byTable.get(name) ?? [...index.byTable].find(([key]) => key.toLocaleLowerCase() === name.toLocaleLowerCase())?.[1] ?? [];
    } else if (identifier?.text.startsWith('"')) candidates = index.all;
    if (!context.explicit && !identifier && !dot) return null;
    const prefix = text.slice(from, pos);
    const query = (prefix.startsWith('"') ? decodeIdentifier(prefix) : prefix).toLocaleLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const matches = candidates.filter(item => words.every(word => item.search.includes(word)));
    matches.sort((a, b) => Number(b.option.label.toLocaleLowerCase().startsWith(query)) - Number(a.option.label.toLocaleLowerCase().startsWith(query))
      || a.option.label.localeCompare(b.option.label));
    return { from, to, options: matches.map(item => item.option), filter: false };
  };
}
