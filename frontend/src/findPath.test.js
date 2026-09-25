import assert from 'node:assert/strict';
import test from 'node:test';
import { findPath } from './findPath.js';

const tables = ['orders', 'items', 'payments', 'isolated'].map((id) => ({ id }));
const relationships = [
  { key: 'items-orders', source: 'items', target: 'orders', columns: [['order_id', 'id'], ['tenant', 'tenant_id']] },
  { key: 'payments-items', source: 'payments', target: 'items', columns: [['item_id', 'id']] },
];

test('traces multiple hops backwards and preserves every composite key column', () => {
  const original = structuredClone(relationships);
  const path = findPath(tables, relationships, 'orders', 'payments');
  assert.deepEqual(path.tableIds, ['orders', 'items', 'payments']);
  assert.deepEqual(path.steps.map((step) => [step.from, step.to, step.relationship.key, step.columns]), [
    ['orders', 'items', 'items-orders', [['id', 'order_id'], ['tenant_id', 'tenant']]],
    ['items', 'payments', 'payments-items', [['id', 'item_id']]],
  ]);
  assert.deepEqual(relationships, original);
});

test('reverse endpoint order reverses the route and column mappings', () => {
  const path = findPath(tables, relationships, 'payments', 'orders');
  assert.deepEqual(path.tableIds, ['payments', 'items', 'orders']);
  assert.deepEqual(path.steps.map((step) => step.columns), [relationships[1].columns, relationships[0].columns]);
});

test('chooses a shortest path even when a longer route appears first', () => {
  const direct = { key: 'direct', source: 'orders', target: 'payments', columns: [['id', 'order_id']] };
  const path = findPath(tables, [...relationships, direct], 'orders', 'payments');
  assert.deepEqual(path.tableIds, ['orders', 'payments']);
  assert.equal(path.steps[0].relationship.key, 'direct');
});

test('disconnected tables and unavailable endpoints have no path', () => {
  assert.equal(findPath(tables, relationships, 'orders', 'isolated'), null);
  assert.equal(findPath(tables, relationships, '', 'orders'), null);
  assert.equal(findPath(tables, relationships, 'missing', 'missing'), null);
});

test('a table is connected to itself without joins', () => {
  assert.deepEqual(findPath(tables, relationships, 'orders', 'orders'), { tableIds: ['orders'], steps: [] });
});

test('handles cycles, self-edges, parallel edges, and missing mappings', () => {
  const edges = [
    { key: 'self', source: 'orders', target: 'orders', columns: [] },
    ...relationships,
    { key: 'parallel', source: 'items', target: 'orders', columns: [['other_id', 'id']] },
    { key: 'cycle', source: 'orders', target: 'payments', columns: [] },
  ];
  assert.equal(findPath(tables, edges, 'orders', 'isolated'), null);
  assert.deepEqual(findPath(tables, edges, 'orders', 'payments').steps[0].columns, []);
  assert.equal(findPath(tables, edges, 'orders', 'items').steps[0].relationship.key, 'items-orders');
});

test('only uses scoped tables and keeps duplicate table names distinct', () => {
  const scopedTables = [{ id: 'a/orders', name: 'Orders' }, { id: 'b/orders', name: 'Orders' }];
  const edges = [
    { key: 'a-outside', source: 'a/orders', target: 'outside', columns: [] },
    { key: 'outside-b', source: 'outside', target: 'b/orders', columns: [] },
  ];
  assert.equal(findPath(scopedTables, edges, 'a/orders', 'b/orders'), null);
});
