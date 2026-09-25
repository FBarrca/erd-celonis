import { modelId, validateView } from './savedViews.js';

export const MAX_STATE_BYTES = 25 * 1024 * 1024;
const LAST_GRAPH_KEY = 'erd-celonis:imported-graph:v1';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const optionalText = value => value == null || text(value);
const point = value => object(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
const fail = message => { throw new Error(message); };

function validateGraph(graph) {
  if (!object(graph) || !object(graph.metadata) || !Array.isArray(graph.tables) || !graph.tables.length
    || !Array.isArray(graph.relationships)) fail('The file does not contain a datapool schema.');
  for (const key of ['data_pool_id', 'data_pool_name', 'data_model_id', 'data_model_name']) {
    if (!optionalText(graph.metadata[key])) fail('Invalid datapool metadata.');
  }
  const ids = new Set();
  for (const table of graph.tables) {
    if (!object(table) || !text(table.id) || !table.id || ids.has(table.id) || table.id.startsWith('note:')
      || !['name', 'alias', 'table_id', 'namespace', 'data_model_id', 'data_model_name'].every(key => optionalText(table[key]))
      || !modelId(graph, table) || !Array.isArray(table.primary_keys) || !table.primary_keys.every(text)
      || !Array.isArray(table.columns) || !table.columns.every(column => object(column) && text(column.name) && optionalText(column.type))) {
      fail('Invalid or duplicate table metadata.');
    }
    ids.add(table.id);
  }
  const keys = new Set();
  for (const edge of graph.relationships) {
    if (!object(edge) || !text(edge.key) || !edge.key || keys.has(edge.key) || !ids.has(edge.source) || !ids.has(edge.target)
      || !optionalText(edge.label) || !Array.isArray(edge.columns)
      || !edge.columns.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(text))) {
      fail('Invalid relationship metadata or missing endpoint table.');
    }
    keys.add(edge.key);
  }
  return graph;
}

export function validateDatapoolState(record) {
  if (!object(record) || record.format !== 'erd-celonis-datapool' || record.version !== 1) {
    fail('Choose an ERD Explorer datapool export (version 1).');
  }
  const graph = validateGraph(record.graph);
  const scopes = [...new Set(graph.tables.map(table => modelId(graph, table)))];
  if (!scopes.includes(record.activeModel) || !object(record.views)) fail('Invalid selected model or saved layouts.');
  const views = Object.fromEntries(scopes.map(scope => {
    const raw = record.views[scope];
    const view = validateView(raw);
    const tableIds = new Set(graph.tables.filter(table => modelId(graph, table) === scope).map(table => table.id));
    if (!view || !Object.entries(raw.positions).every(([id, position]) => tableIds.has(id) && point(position))
      || [...tableIds].some(id => !Object.hasOwn(view.positions, id))
      || (raw.viewport != null && !view.viewport) || !Array.isArray(raw.notes) || raw.notes.length !== view.notes.length
      || view.notes.some(note => graph.tables.some(table => table.id === note.id))) {
      fail('Invalid table positions, notes, or viewport in a saved model.');
    }
    return [scope, view];
  }));
  return { format: 'erd-celonis-datapool', version: 1, graph, activeModel: record.activeModel, views };
}

export function parseDatapoolState(source) {
  let value;
  try { value = JSON.parse(source); } catch { fail('This file is not valid JSON. Choose a datapool export.'); }
  return validateDatapoolState(value);
}

export function createDatapoolState(graph, activeModel, views) {
  return validateDatapoolState({ format: 'erd-celonis-datapool', version: 1, graph, activeModel, views });
}

// Persist only the schema here. Layouts continue to use the per-pool/model view store,
// so subsequent edits are restored instead of replaying the original import.
export function rememberImportedGraph(graph, getStorage = () => window.localStorage) {
  try {
    getStorage().setItem(LAST_GRAPH_KEY, JSON.stringify({ version: 1, graph }));
    return true;
  } catch { return false; }
}

export function loadImportedGraph(getStorage = () => window.localStorage) {
  try {
    const record = JSON.parse(getStorage().getItem(LAST_GRAPH_KEY));
    return record?.version === 1 ? validateGraph(record.graph) : null;
  } catch { return null; }
}
