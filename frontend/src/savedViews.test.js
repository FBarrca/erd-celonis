import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewStore, modelId, restorePositions, validateView } from './savedViews.js';

function storage() {
  const records = new Map();
  return { records, getItem: (key) => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
}
const graph = {
  metadata: { data_pool_id: 'pool', data_pool_name: 'Sales' },
  tables: [{ id: 'a/orders', data_model_id: 'a' }, { id: 'b/orders', data_model_id: 'b' }],
};
const nodes = [{ id: 'a/orders', position: { x: -125, y: 75 } }];
const viewport = { x: 80, y: -20, zoom: 0.6 };

test('positions and viewport survive a new store instance', () => {
  const disk = storage();
  createViewStore(() => disk).save(graph, 'a', nodes, viewport);
  const view = createViewStore(() => disk).load(graph, 'a');
  assert.deepEqual(view, { version: 1, positions: { 'a/orders': nodes[0].position }, viewport });
  nodes[0].position.x = 99;
  assert.equal(view.positions['a/orders'].x, -125);
  nodes[0].position.x = -125;
});

test('identity survives renamed, reordered, added, or removed tables', () => {
  const disk = storage();
  createViewStore(() => disk).save(graph, 'a', nodes, viewport);
  const changed = structuredClone(graph);
  changed.metadata.data_pool_name = 'Renamed';
  changed.tables = [{ id: 'a/new', data_model_id: 'a', data_model_name: 'Renamed model' }];
  assert.deepEqual(createViewStore(() => disk).load(changed, 'a')?.viewport, viewport);
  assert.deepEqual(createViewStore(() => disk).load({ ...graph, tables: [...graph.tables].reverse() }, 'a')?.viewport, viewport);
});

test('pools and individual models have independent views', () => {
  const views = createViewStore(() => storage());
  views.save(graph, 'a', nodes, viewport);
  assert.equal(views.load(graph, 'b'), null);
  assert.equal(views.load({ ...graph, metadata: { data_pool_id: 'other' } }, 'a'), null);
  views.save(graph, 'b', nodes, { ...viewport, zoom: 1.5 });
  assert.equal(views.load(graph, 'b').viewport.zoom, 1.5);
  assert.equal(views.load(graph, 'a').viewport.zoom, 0.6);
  assert.equal(views.load({ ...graph, tables: graph.tables.slice(0, 1) }, 'a').viewport.zoom, 0.6);
});

test('last valid scope is restored and stale or unsupported preferences fall back', () => {
  const disk = storage();
  const views = createViewStore(() => disk);
  assert.equal(views.loadScope(graph), 'a');
  assert.equal(views.loadScope({ ...graph, tables: [...graph.tables].reverse() }), 'b');
  views.saveScope(graph, 'b');
  assert.equal(createViewStore(() => disk).loadScope(graph), 'b');
  assert.equal(views.loadScope({ ...graph, tables: [...graph.tables, { id: 'c/new', data_model_id: 'c' }] }), 'b');
  assert.equal(views.loadScope({ ...graph, tables: graph.tables.slice(0, 1) }), 'a');
  views.saveScope(graph, 'missing');
  assert.equal(views.loadScope(graph), 'a');
  assert.equal(views.loadScope({ ...graph, tables: graph.tables.slice(0, 1) }), 'a');
  for (const key of disk.records.keys()) disk.records.set(key, JSON.stringify({ version: 2, scope: 'b' }));
  assert.equal(createViewStore(() => disk).loadScope(graph), 'a');
});

test('legacy all-model preference falls back without losing individual layouts', () => {
  const disk = storage();
  const views = createViewStore(() => disk);
  views.save(graph, 'a', nodes, viewport);
  views.saveScope(graph, 'all');
  const reopened = createViewStore(() => disk);
  assert.equal(reopened.loadScope(graph), 'a');
  assert.deepEqual(reopened.load(graph, 'a').viewport, viewport);
  assert.equal(reopened.loadScope({ ...graph, tables: [] }), '');
});

test('direct-model metadata and namespaces identify models without pool metadata', () => {
  const direct = { metadata: { data_model_id: 'a' }, tables: [{ id: 'table:orders' }] };
  assert.equal(modelId(direct, direct.tables[0]), 'a');
  assert.equal(modelId({ metadata: {} }, { namespace: 'b' }), 'b');
  const views = createViewStore(() => storage());
  views.save(direct, 'a', nodes, viewport);
  assert.deepEqual(views.load(direct, 'a').viewport, viewport);
  const unknown = { metadata: {}, tables: [{ id: 'unknown' }] };
  views.save(unknown, '', nodes, viewport);
  assert.equal(views.load(unknown, ''), null);
});

test('restoration preserves matched positions and places new nodes outside their bounds', () => {
  const initial = [
    { id: 'kept', position: { x: 0, y: 0 } },
    { id: 'new1', position: { x: 0, y: 300 } },
    { id: 'new2', position: { x: 400, y: 300 } },
  ];
  const view = validateView({ version: 1, positions: { kept: { x: 900, y: -50 }, removed: { x: 9000, y: 0 } }, viewport });
  const restored = restorePositions(initial, view, 286, 76);
  assert.deepEqual(restored.map((node) => node.position), [{ x: 900, y: -50 }, { x: 1262, y: 300 }, { x: 1662, y: 300 }]);
  assert.deepEqual(initial[0].position, { x: 0, y: 0 });
  assert.equal(restorePositions(initial, null, 286, 76), initial);
  assert.equal(restorePositions(initial, { positions: {} }, 286, 76), initial);
});

test('malformed records, invalid coordinates, and out-of-range zoom are ignored', () => {
  for (const record of [null, [], {}, { version: 2, positions: {} }, { version: 1, positions: [] }]) assert.equal(validateView(record), null);
  const positions = { valid: { x: -10, y: 20 }, bad: { x: Infinity, y: 0 }, string: { x: '1', y: 0 }, missing: null };
  for (const zoom of [0, -1, 0.01, 3, Infinity, '1', null]) {
    assert.deepEqual(validateView({ version: 1, positions, viewport: { x: 0, y: 0, zoom } }), {
      version: 1, positions: { valid: { x: -10, y: 20 } }, viewport: null,
    });
  }
  assert.equal(validateView({ version: 1, positions: {}, viewport: { ...viewport, x: NaN } }).viewport, null);
  const disk = storage();
  createViewStore(() => disk).save(graph, 'a', nodes, viewport);
  for (const key of disk.records.keys()) disk.records.set(key, '{broken');
  assert.equal(createViewStore(() => disk).load(graph, 'a'), null);
});

test('denied access and quota failures preserve in-memory scope views', () => {
  for (const getStorage of [
    () => { throw new Error('SecurityError'); },
    () => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } }),
  ]) {
    const views = createViewStore(getStorage);
    assert.equal(views.load(graph, 'a'), null);
    views.save(graph, 'a', nodes, viewport);
    views.saveScope(graph, 'a');
    views.save(graph, 'b', [], { ...viewport, zoom: 1 });
    assert.deepEqual(views.load(graph, 'a').viewport, viewport);
    assert.equal(views.load(graph, 'b').viewport.zoom, 1);
    assert.equal(views.loadScope(graph), 'a');
  }
});
