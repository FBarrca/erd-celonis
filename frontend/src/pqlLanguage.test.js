import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { createPqlCompletionIndex, createPqlCompletionSource, expressionLengthLimit, MAX_EXPRESSION_LENGTH, pqlLanguage, tokenizePql } from './pqlLanguage.js';

const tables = [
  { name: 'ORDERS_RAW', alias: 'Orders', columns: [{ name: 'ID', type: 'INTEGER' }, { name: 'Order Value', type: 'FLOAT' }] },
  { name: 'CUSTOMERS', alias: 'Customer "Details"', columns: [{ name: 'ID', type: 'STRING' }, { name: 'Full "Name"', type: 'STRING' }] },
];
const index = createPqlCompletionIndex(tables);
function complete(text, { pos = text.length, schema = index, filter = false, explicit = true } = {}) {
  return createPqlCompletionSource(schema, filter)(new CompletionContext(EditorState.create({ doc: text }), pos, explicit));
}
function insert(text, label, config) {
  const result = complete(text, config);
  const option = result.options.find(item => item.label === label);
  assert.ok(option, `${label} is suggested for ${text}`);
  return text.slice(0, result.from) + option.apply + text.slice(result.to);
}

test('PQL tokens distinguish identifiers, strings, functions, keywords, numbers and operators', () => {
  const tokens = tokenizePql('CASE WHEN "Orders"."ID" >= 1.2e3 THEN SUM("Orders"."Order Value") ELSE \'it\\\'s fine\' END');
  assert.equal(tokens.find(t => t.text === 'CASE').type, 'keyword');
  assert.equal(tokens.find(t => t.text === '"Orders"').type, 'variableName');
  assert.equal(tokens.find(t => t.text === '1.2e3').type, 'number');
  assert.equal(tokens.find(t => t.text === 'SUM').type, 'function');
  assert.equal(tokens.find(t => t.type === 'string').text, "'it\\'s fine'");
  assert.ok(tokens.some(t => t.type === 'operator'));
  const state = EditorState.create({ doc: 'SUM("Orders"."ID")', extensions: [pqlLanguage] });
  assert.match(syntaxTree(state).toString(), /function/);
});

test('multiline strings and comments suppress completions, including escaped quotes', () => {
  for (const text of ["'Orders", "'it\\'s Orders", "'line one\nOrders", '/* Orders', '-- Orders']) {
    assert.equal(complete(text), null, text);
  }
  assert.ok(complete("'done' || Ord").options.some(c => c.label === 'Orders'));
  assert.ok(complete('/* done */ Ord').options.some(c => c.label === 'Orders'));
});

test('schema matching ignores case, searches physical names and inserts aliases', () => {
  assert.equal(insert('ordeRS_raw', 'Orders'), '"Orders"');
  assert.equal(insert('order value', 'Orders.Order Value', { pos: 5 }), '"Orders"."Order Value" value');
  assert.equal(insert('Val', 'Orders.Order Value'), '"Orders"."Order Value"');
  assert.equal(insert('Customer', 'Customer "Details"'), '"Customer ""Details"""');
});

test('qualified context offers only columns of the named table, with types', () => {
  const result = complete('"Orders".');
  assert.deepEqual(result.options.map(c => c.label), ['ID', 'Order Value']);
  assert.match(result.options[0].detail, /Orders.*INTEGER/);
  assert.equal(insert('"Orders".i', 'ID'), '"Orders"."ID"');
  assert.equal(insert('"orders" . ', 'ID'), '"orders" . "ID"');
  assert.deepEqual(complete('"Unknown".').options, []);
  assert.equal(insert('"Customer ""Details"""."Full', 'Full "Name"'), '"Customer ""Details"""."Full ""Name"""');
});

test('partial quoted and unquoted replacements consume existing suffixes and quotes', () => {
  assert.equal(insert('SUM("Ord")', 'Orders', { pos: 8 }), 'SUM("Orders")');
  assert.equal(insert('"Orders"."Ord Value"', 'Order Value', { pos: 12 }), '"Orders"."Order Value"');
  assert.equal(insert('Ordx', 'Orders', { pos: 2 }), '"Orders"');
  assert.equal(insert('"Orders".""', 'ID', { pos: 10 }), '"Orders"."ID"');
  const multiline = 'TABLE(\n  "Orders"."Ord\n);';
  assert.equal(insert(multiline, 'Order Value', { pos: multiline.indexOf('\n);') }), 'TABLE(\n  "Orders"."Order Value"\n);');
});

test('models have separate indexes and tables without column metadata still complete', () => {
  const other = createPqlCompletionIndex([{ name: 'Invoices' }]);
  assert.equal(complete('Orders', { schema: other }).options.length, 0);
  assert.equal(insert('Inv', 'Invoices', { schema: other }), '"Invoices"');
  assert.equal(complete('"Invoices".', { schema: other }).options.length, 0);
});

test('function snippets provide descriptions and FILTER is limited to filter fields', () => {
  for (const name of ['COUNT_TABLE', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'PU_COUNT', 'PU_SUM', 'CASE WHEN']) {
    const option = complete(name).options.find(c => c.label === name);
    assert.equal(typeof option.apply, 'function');
    assert.ok(option.info);
  }
  assert.equal(complete('FILT').options.length, 0);
  assert.equal(typeof complete('FILT', { filter: true }).options[0].apply, 'function');
  assert.equal(complete('', { explicit: false }), null);
  assert.ok(complete('', { explicit: true }).options.length);
});

test('length limit rejects typing, paste or completion beyond the bound and permits recovery', () => {
  let state = EditorState.create({ doc: 'x'.repeat(MAX_EXPRESSION_LENGTH - 1), extensions: [expressionLengthLimit] });
  state = state.update({ changes: { from: state.doc.length, insert: 'y' } }).state;
  assert.equal(state.doc.length, MAX_EXPRESSION_LENGTH);
  assert.equal(state.update({ changes: { from: 0, insert: 'too much' } }).state.doc.length, MAX_EXPRESSION_LENGTH);
  assert.equal(state.update({ changes: { from: 0, to: 10, insert: 'short' } }).state.doc.length, MAX_EXPRESSION_LENGTH - 5);
  state = EditorState.create({ doc: 'x'.repeat(MAX_EXPRESSION_LENGTH + 10), extensions: [expressionLengthLimit] });
  assert.equal(state.update({ changes: { from: 0, to: 1 } }).state.doc.length, MAX_EXPRESSION_LENGTH + 9);
});

test('large schema indexes can be reused and qualified lookup stays isolated', () => {
  const large = createPqlCompletionIndex(Array.from({ length: 500 }, (_, i) => ({ name: `Table ${i}`, columns: Array.from({ length: 30 }, (_, j) => ({ name: `Column ${j}` })) })));
  assert.equal(large.all.length, 15500);
  assert.equal(complete('"Table 410".', { schema: large }).options.length, 30);
  assert.equal(complete('"Table 410"."Column 2', { schema: large }).options.length, 12);
});
