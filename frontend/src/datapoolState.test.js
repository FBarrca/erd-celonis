import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatapoolState, parseDatapoolState, rememberImportedGraph, loadImportedGraph } from './datapoolState.js';
import { createViewStore } from './savedViews.js';
import { noteNode } from './stickyNotes.js';

const graph = {
  metadata: { data_pool_id: 'pool', data_pool_name: 'Sales & purchasing' },
  tables: ['a/orders', 'a/customers', 'b/orders'].map(id => ({
    id, name: id, table_id: id, alias: null, data_model_id: id[0], namespace: id[0],
    columns: [{ name: 'ID', type: 'INTEGER' }], primary_keys: ['ID'],
  })),
  relationships: [{ key: 'fk', source: 'a/orders', target: 'a/customers', columns: [['ID', 'ID']], label: 'ID → ID' }],
};
const note = { id: 'note:one', title: 'Join checks', text: '# TODO\n**Check** this join', position: { x: -120, y: 330 } };
const views = {
  a: { version: 1, positions: { 'a/orders': { x: -10, y: 30 }, 'a/customers': { x: 400, y: 50 } },
    viewport: { x: 82, y: -25, zoom: 0.75 }, notes: [note] },
  b: { version: 1, positions: { 'b/orders': { x: 70, y: 70 } }, viewport: null,
    notes: [{ ...note, id: 'note:two', title: 'Purchasing' }] },
};
const snapshot = () => createDatapoolState(structuredClone(graph), 'b', structuredClone(views));
const disk = () => {
  const records = new Map();
  return { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
};

test('JSON round trip includes full schema and every model layout, note and selected scope', () => {
  const restored = parseDatapoolState(JSON.stringify(snapshot()));
  assert.deepEqual(restored.graph, graph);
  assert.deepEqual(restored.views, views);
  assert.equal(restored.activeModel, 'b');
});

test('imported views replace existing pool layouts and later edits survive a new store', () => {
  const storage = disk();
  const store = createViewStore(() => storage);
  store.save(graph, 'a', [], { x: 0, y: 0, zoom: 1 });
  const imported = snapshot();
  for (const [scope, view] of Object.entries(imported.views)) store.restore(imported.graph, scope, view);
  store.saveScope(graph, imported.activeModel);
  assert.deepEqual(createViewStore(() => storage).load(graph, 'a'), views.a);
  assert.equal(createViewStore(() => storage).loadScope(graph), 'b');
  const updated = { ...note, text: 'Edited offline', title: 'Updated', position: { x: 90, y: 100 } };
  store.save(graph, 'a', [noteNode(updated), ...Object.entries(views.a.positions).map(([id, position]) => ({ id, position }))], views.a.viewport);
  assert.deepEqual(createViewStore(() => storage).load(graph, 'a').notes, [updated]);
  assert.deepEqual(createViewStore(() => storage).load(graph, 'b'), views.b);
  assert.equal(createViewStore(() => storage).load({ ...graph, metadata: { data_pool_id: 'other' } }, 'a'), null);
});

test('offline schema can be reopened without replaying imported layouts', () => {
  const storage = disk();
  assert.equal(loadImportedGraph(() => storage), null);
  assert.equal(rememberImportedGraph(graph, () => storage), true);
  assert.deepEqual(loadImportedGraph(() => storage), graph);
  const unavailable = () => { throw Error('denied'); };
  assert.equal(rememberImportedGraph(graph, unavailable), false);
  assert.equal(loadImportedGraph(unavailable), null);
});

test('invalid imports reject unsupported formats and corrupt schemas or layouts', () => {
  assert.throws(() => parseDatapoolState('{broken'), /valid JSON/);
  for (const mutate of [
    value => { value.version = 2; },
    value => { value.graph.tables.push(value.graph.tables[0]); },
    value => { value.graph.tables[0].columns = [null]; },
    value => { value.graph.tables[0].name = {}; },
    value => { value.graph.relationships[0].target = 'missing'; },
    value => { value.graph.relationships[0].columns = ['ID']; },
    value => { value.activeModel = 'missing'; },
    value => { delete value.views.a; },
    value => { value.views.a.positions['a/orders'] = { x: null, y: 0 }; },
    value => { delete value.views.a.positions['a/orders']; },
    value => { value.views.a.viewport.zoom = 0; },
    value => { value.views.a.notes.push(value.views.a.notes[0]); },
    value => { value.views.a.notes[0].position = null; },
  ]) {
    const value = snapshot();
    mutate(value);
    assert.throws(() => parseDatapoolState(JSON.stringify(value)));
  }
});

test('state files cannot inject editor flags or node callbacks through note data', () => {
  const value = snapshot();
  Object.assign(value.views.a.notes[0], { autoFocus: true, data: { unexpected: true } });
  assert.deepEqual(parseDatapoolState(JSON.stringify(value)).views.a.notes[0], note);
});
