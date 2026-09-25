import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearchIndex, normalizeLabel, searchIndex } from './search.js';

const table = (id, name, columns = [], extra = {}) => ({
  id, name, data_model_id: 'sales', data_model_name: 'Sales',
  columns: columns.map((name) => ({ name })), ...extra,
});
const find = (tables, query) => searchIndex(createSearchIndex(tables), query);

test('recovers typos but places exact, prefix and substring names first', () => {
  const tables = ['CUSTOMER', 'CUSTOMERS', 'OLD_CUSTOMER', 'CUSTMER'].map((name) => table(name, name));
  assert.deepEqual(find(tables, 'customer').map((r) => r.labels.name), ['CUSTOMER', 'CUSTOMERS', 'OLD_CUSTOMER', 'CUSTMER']);
  assert.equal(find([tables[0]], 'custmer')[0].table.id, 'CUSTOMER');
  assert.equal(find(tables, 'zzzzzzzzzz').length, 0);
});

test('searches physical table names hidden by aliases and shows matching field', () => {
  const [result] = find([table('a', 'SAP_BSEG', [], { alias: 'Invoice items' })], 'bseg');
  assert.equal(result.labels.name, 'Invoice items');
  assert.deepEqual(result.highlights.physical, [[4, 7]]);
});

test('normalizes case and separator runs while preserving original highlight offsets', () => {
  const name = '  CUSTOMER__ .-ID';
  assert.equal(normalizeLabel(name).text, 'customer id');
  const [result] = find([table('a', name)], 'customer.id');
  assert.equal(result.rank, 0);
  const highlighted = result.highlights.name.map(([a, b]) => name.slice(a, b + 1));
  assert.deepEqual(highlighted, ['CUSTOMER', 'ID']);
  const normalized = normalizeLabel('İD_😀_Code');
  assert.equal(normalized.text, 'i̇d 😀 code');
  assert.deepEqual(normalized.offsets.slice(0, 3), [[0, 0], [0, 0], [1, 1]]);
});

test('requires every word, matching column and parent names in either order', () => {
  const tables = [table('orders', 'ORDERS', ['CUSTOMER_ID', 'TOTAL']), table('customers', 'CUSTOMERS', ['ID'])];
  for (const query of ['orders customer id', 'id orders customer', 'ordrs customer id']) {
    const results = find(tables, query);
    assert.equal(results.length, 1);
    assert.equal(results[0].column, 'CUSTOMER_ID');
    assert.equal(results[0].table.id, 'orders');
  }
  assert.equal(find(tables, 'orders zzzzzzzz').length, 0);
});

test('column queries can use a physical parent name beneath an alias', () => {
  const results = find([table('a', 'SAP_BSEG', ['AMOUNT'], { alias: 'Invoices' })], 'bseg amount');
  assert.equal(results.length, 1);
  assert.ok(results[0].highlights.parentPhysical);
});

test('duplicate names remain distinct and ties are stable across input order', () => {
  const tables = [table('b', 'CUSTOMER', ['ID']), table('a', 'CUSTOMER', ['ID'])];
  const results = find(tables, 'customer');
  assert.equal(new Set(results.map((r) => r.id)).size, 4);
  assert.deepEqual(results.map((r) => r.id), find([...tables].reverse(), 'customer').map((r) => r.id));
  assert.deepEqual(results.slice(0, 2).map((r) => r.kind), ['table', 'table']);
});

test('index contains only supplied scope and does not mutate graph data', () => {
  const tables = [table('a', 'ORDERS'), table('b', 'ORDERS', [], { data_model_id: 'finance' })];
  const before = structuredClone(tables);
  assert.deepEqual(find(tables.filter((t) => t.data_model_id === 'finance'), 'orders').map((r) => r.table.id), ['b']);
  assert.deepEqual(tables, before);
});

test('missing columns, empty scopes, and empty queries are safe', () => {
  assert.equal(find([{ id: 'a', name: 'ORDERS' }], 'orders').length, 1);
  assert.deepEqual(find([], 'orders'), []);
  for (const query of ['', '  ', '__.-']) assert.deepEqual(find([table('a', 'ORDERS')], query), []);
});

test('long identifiers match beyond character 60 and support long query terms', () => {
  const long = 'VERY_LONG_IDENTIFIER_'.repeat(5) + 'DISTINCTIVE_SUFFIX';
  const tables = [table('a', long)];
  assert.equal(find(tables, 'distinctive suffix')[0].table.id, 'a');
  const singleWord = 'abcdefghijklmnopqrstuvwxyzaabbccddeeffgghhiijjkk';
  assert.equal(find([table('b', singleWord)], singleWord)[0].rank, 0);
});

test('does not silently truncate results at 8 or 50', () => {
  const tables = Array.from({ length: 120 }, (_, i) => table(String(i), `ORDERS_${i}`));
  assert.equal(find(tables, 'orders').length, 120);
});

test('extended search operators remain literal', () => {
  const results = find([table('a', '!orders'), table('b', 'customers')], '!orders');
  assert.equal(results[0].table.id, 'a');
  assert.equal(results.some((r) => r.table.id === 'b'), false);
});
