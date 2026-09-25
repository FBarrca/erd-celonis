import { validateNotes } from './stickyNotes.js';

export const MIN_ZOOM = 0.08;
export const MAX_ZOOM = 2;
const PREFIX = 'erd-celonis:view:v1:';

export function modelId(graph, table) {
  return String(table.data_model_id ?? graph.metadata?.data_model_id ?? table.namespace ?? '');
}

function modelIds(graph) {
  return [...new Set(graph.tables.map((table) => modelId(graph, table)).filter(Boolean))].sort();
}

function keyFor(graph, scope, preference = false) {
  const ids = modelIds(graph);
  if (!ids.length) return null;
  const pool = String(graph.metadata?.data_pool_id ?? '');
  // Names and table membership can change without creating a new diagram.
  return PREFIX + JSON.stringify([
    pool,
    preference ? 'scope' : 'layout',
    preference ? (pool ? [] : ids) : [scope],
    preference ? null : scope,
  ]);
}

const validPoint = (point) => point && Number.isFinite(point.x) && Number.isFinite(point.y);
const validViewport = (viewport) => validPoint(viewport)
  && Number.isFinite(viewport.zoom) && viewport.zoom >= MIN_ZOOM && viewport.zoom <= MAX_ZOOM;

export function validateView(record) {
  if (!record || record.version !== 1 || !record.positions || typeof record.positions !== 'object' || Array.isArray(record.positions)) return null;
  const positions = Object.fromEntries(Object.entries(record.positions)
    .filter(([, point]) => validPoint(point)).map(([id, { x, y }]) => [id, { x, y }]));
  const viewport = validViewport(record.viewport)
    ? { x: record.viewport.x, y: record.viewport.y, zoom: record.viewport.zoom } : null;
  const notes = validateNotes(record.notes).filter((note) => !Object.hasOwn(positions, note.id));
  return { version: 1, positions, viewport, notes };
}

export function createViewStore(getStorage = () => window.localStorage) {
  // Also retain views for scope switching if browser storage is denied or full.
  const memory = new Map();
  function read(key) {
    if (!key) return null;
    if (memory.has(key)) return memory.get(key);
    try {
      const value = JSON.parse(getStorage().getItem(key));
      memory.set(key, value);
      return value;
    } catch { return null; }
  }
  function write(key, value) {
    if (!key) return;
    memory.set(key, value);
    try { getStorage().setItem(key, JSON.stringify(value)); } catch { /* Keep the in-memory view. */ }
  }
  return {
    load(graph, scope) { return validateView(read(keyFor(graph, scope))); },
    save(graph, scope, nodes, viewport) {
      const view = validateView({
        version: 1,
        positions: Object.fromEntries(nodes.filter((node) => node.type !== 'stickyNote').map((node) => [node.id, node.position])),
        viewport,
        notes: nodes.filter((node) => node.type === 'stickyNote').map((node) => ({ id: node.id, title: node.data.title, text: node.data.text, position: node.position })),
      });
      if (view) write(keyFor(graph, scope), view);
    },
    loadScope(graph) {
      const ids = modelIds(graph);
      const fallback = graph.tables.length ? modelId(graph, graph.tables[0]) : '';
      const record = read(keyFor(graph, null, true));
      return record?.version === 1 && ids.includes(record.scope) ? record.scope : fallback;
    },
    saveScope(graph, scope) { write(keyFor(graph, null, true), { version: 1, scope }); },
  };
}

export function restorePositions(nodes, view, width, gap) {
  if (!view) return nodes;
  const restored = nodes.filter((node) => Object.hasOwn(view.positions, node.id));
  if (!restored.length) return nodes;
  const added = nodes.filter((node) => !Object.hasOwn(view.positions, node.id));
  const right = Math.max(...restored.map((node) => view.positions[node.id].x + width));
  const left = added.length ? Math.min(...added.map((node) => node.position.x)) : 0;
  return nodes.map((node) => ({
    ...node,
    position: Object.hasOwn(view.positions, node.id)
      ? { ...view.positions[node.id] }
      : { x: node.position.x + right + gap - left, y: node.position.y },
  }));
}
