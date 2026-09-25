import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { findPath } from './findPath';
import PathFinder from './PathFinder';
import Search from './Search.jsx';
import QueryPanel from './QueryPanel.jsx';
import StickyNote from './StickyNote.jsx';
import StateTransfer from './StateTransfer.jsx';
import { createDatapoolState, loadImportedGraph, rememberImportedGraph } from './datapoolState.js';
import { noteNode, NOTE_WIDTH, NOTE_HEIGHT } from './stickyNotes.js';
import { createDraftStore } from './queryDrafts.js';
import { createViewStore, modelId, restorePositions, MIN_ZOOM, MAX_ZOOM } from './savedViews.js';

const NODE_WIDTH = 286;
const ROW_HEIGHT = 31;
const HEADER_HEIGHT = 74;
const MAX_VISIBLE_COLUMNS = 10;
const TARGET_LAYOUT_ASPECT = 1.8;
const MAX_LAYOUT_ASPECT = 2.5;
const HORIZONTAL_GAP = 76;
const VERTICAL_GAP = 130;

function Icon({ name, size = 18 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
    table: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 9v11"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></>,
    chevron: <path d="m8 10 4 4 4-4"/>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function displayName(table) {
  return table.alias || table.name || String(table.table_id || table.id);
}

function tableHeaderKind(table) {
  const names = [table.alias, table.name].filter(Boolean).map((name) => String(name).trim().toLocaleLowerCase());
  if (names.some((name) => name.startsWith('o_'))) return 'object';
  if (names.some((name) => name.startsWith('e_'))) return 'event';
  if (names.some((name) => name.startsWith('c_'))) return 'case';
  return 'other';
}

function markerFor(column, table, foreignColumns) {
  const name = column.name.toLocaleLowerCase();
  const isPrimary = table.primary_keys.some((key) => String(key).toLocaleLowerCase() === name);
  const isForeign = foreignColumns.has(name);
  if (isPrimary && isForeign) return 'PK/FK';
  if (isPrimary) return 'PK';
  if (isForeign) return 'FK';
  return '';
}

function visibleColumns(table, relationships) {
  if (table.columns.length <= MAX_VISIBLE_COLUMNS) return table.columns;
  const important = new Set(table.primary_keys.map((value) => String(value).toLocaleLowerCase()));
  relationships.forEach((relationship) => {
    if (relationship.source === table.id) relationship.columns.forEach(([source]) => important.add(String(source).toLocaleLowerCase()));
    if (relationship.target === table.id) relationship.columns.forEach(([, target]) => important.add(String(target).toLocaleLowerCase()));
  });
  const selected = table.columns.filter((column) => important.has(column.name.toLocaleLowerCase()));
  for (const column of table.columns) {
    if (selected.length >= MAX_VISIBLE_COLUMNS) break;
    if (!selected.includes(column)) selected.push(column);
  }
  return selected;
}

function TableCard({ data }) {
  const table = data.table;
  const visible = data.visibleColumns;
  const hiddenCount = table.columns.length - visible.length;
  return (
    <article className={`table-card table-card--${tableHeaderKind(table)} ${data.isSelected ? 'is-selected' : ''} ${data.isDimmed ? 'is-dimmed' : ''}`}>
      <Handle type="source" position={Position.Top} className="table-handle table-handle--main" />
      <Handle type="target" position={Position.Bottom} className="table-handle table-handle--main" />
      <button className="table-card__header" type="button" onClick={() => data.onSelectTable(table.id)} aria-label={`${data.choosingDestination ? 'Connect to' : 'Inspect'} ${displayName(table)}`}>
        <span className="table-card__model">{table.data_model_name || 'Data model'}</span>
        <strong title={displayName(table)}>{displayName(table)}</strong>
        <span className="table-card__count">{table.columns.length} col{table.columns.length === 1 ? '' : 's'}</span>
      </button>
      <div className="table-card__columns">
        {visible.length ? visible.map((column) => {
          const key = markerFor(column, table, data.foreignColumns);
          return (
            <div className="column-row" key={column.name}>
              <span className="column-row__type" title={column.type || ''}>{column.type || '—'}</span>
              <span className="column-row__name" title={column.name}>{column.name}</span>
              {key && <span className={`key-badge key-badge--${key.toLowerCase().replace('/', '-')}`}>{key}</span>}
            </div>
          );
        }) : <div className="column-row column-row--empty">Columns were not loaded</div>}
        {hiddenCount > 0 && <button type="button" className="more-columns" onClick={() => data.onSelectTable(table.id)}>+ {hiddenCount} more in inspector</button>}
      </div>
    </article>
  );
}

const nodeTypes = { tableCard: TableCard, stickyNote: StickyNote };

function nodeHeight(table, shownColumns) {
  const footer = table.columns.length > shownColumns.length ? 32 : 0;
  return HEADER_HEIGHT + Math.max(shownColumns.length, 1) * ROW_HEIGHT + footer;
}

function positionBounds(items, positions) {
  return items.reduce((bounds, item) => {
    const position = positions.get(item.id);
    return {
      left: Math.min(bounds.left, position.x),
      right: Math.max(bounds.right, position.x + item.width),
      top: Math.min(bounds.top, position.y),
      bottom: Math.max(bounds.bottom, position.y + item.height),
    };
  }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
}

function layoutAspect(items, positions) {
  const bounds = positionBounds(items, positions);
  return (bounds.right - bounds.left) / Math.max(bounds.bottom - bounds.top, 1);
}

function wrapRelationshipRanks(ranks, columnsPerRow) {
  const positions = new Map();
  const canvasWidth = columnsPerRow * NODE_WIDTH + (columnsPerRow - 1) * HORIZONTAL_GAP;
  let y = 70;
  ranks.forEach((rank) => {
    for (let start = 0; start < rank.length; start += columnsPerRow) {
      const row = rank.slice(start, start + columnsPerRow);
      const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * HORIZONTAL_GAP;
      let x = 70 + (canvasWidth - rowWidth) / 2;
      const rowHeight = Math.max(...row.map((item) => item.height));
      row.forEach((item) => {
        positions.set(item.id, { x, y: y + (rowHeight - item.height) / 2 });
        x += NODE_WIDTH + HORIZONTAL_GAP;
      });
      y += rowHeight + VERTICAL_GAP;
    }
  });
  return positions;
}

function relationshipAwarePositions(layout, tables, columnMap) {
  const items = tables.map((table) => {
    const point = layout.node(table.id);
    return {
      id: table.id,
      x: point.x,
      y: point.y,
      width: NODE_WIDTH,
      height: nodeHeight(table, columnMap.get(table.id)),
    };
  });
  const direct = new Map(items.map((item) => [item.id, { x: item.x - item.width / 2, y: item.y - item.height / 2 }]));
  if (items.length < 8 || layoutAspect(items, direct) <= MAX_LAYOUT_ASPECT) return direct;

  // Dagre has already assigned relationship depth and minimized crossings.
  // Grouping by its Y coordinate preserves those semantic ranks and X order;
  // only an overloaded rank is wrapped to keep the whole map navigable.
  const grouped = new Map();
  items.forEach((item) => {
    const rankKey = Math.round(item.y);
    if (!grouped.has(rankKey)) grouped.set(rankKey, []);
    grouped.get(rankKey).push(item);
  });
  const ranks = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, rank]) => rank.sort((left, right) => left.x - right.x));
  const largestRank = Math.max(...ranks.map((rank) => rank.length));
  let best = { positions: direct, score: Infinity };
  for (let columns = 3; columns <= largestRank; columns += 1) {
    const positions = wrapRelationshipRanks(ranks, columns);
    const aspect = layoutAspect(items, positions);
    const score = Math.abs(Math.log(aspect / TARGET_LAYOUT_ASPECT));
    if (score < best.score) best = { positions, score };
  }
  return best.positions;
}

function buildElements(graph, activeModel, onSelectTable) {
  const tables = graph.tables.filter((table) => modelId(graph, table) === activeModel);
  const tableIds = new Set(tables.map((table) => table.id));
  const relationships = graph.relationships.filter((relationship) => tableIds.has(relationship.source) && tableIds.has(relationship.target));
  const foreignByTable = new Map(tables.map((table) => [table.id, new Set()]));
  relationships.forEach((relationship) => relationship.columns.forEach(([source]) => foreignByTable.get(relationship.source)?.add(String(source).toLocaleLowerCase())));

  const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  layout.setGraph({ rankdir: 'TB', ranksep: 130, nodesep: 76, edgesep: 28, marginx: 70, marginy: 70, acyclicer: 'greedy', ranker: 'network-simplex' });
  const columnMap = new Map();
  tables.forEach((table) => {
    const shown = visibleColumns(table, relationships);
    columnMap.set(table.id, shown);
    layout.setNode(table.id, { width: NODE_WIDTH, height: nodeHeight(table, shown) });
  });
  // Rank referenced tables above their dependants. This mirrors how schema
  // diagrams are normally read and lets the FK topology determine the map.
  relationships.forEach((relationship) => layout.setEdge(relationship.target, relationship.source));
  dagre.layout(layout);
  const positions = relationshipAwarePositions(layout, tables, columnMap);

  const nodes = tables.map((table) => {
    return {
      id: table.id,
      type: 'tableCard',
      position: positions.get(table.id),
      data: {
        table,
        visibleColumns: columnMap.get(table.id),
        foreignColumns: foreignByTable.get(table.id),
        onSelectTable,
        isSelected: false,
        isDimmed: false,
      },
    };
  });
  const edges = relationships.map((relationship) => {
    return {
      id: relationship.key,
      source: relationship.source,
      target: relationship.target,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      data: { relationship },
      style: { strokeWidth: 1.5 },
    };
  });
  return { nodes, edges, tables, relationships };
}

function DetailPanel({ selection, graph, onClose, onSelectTable, onFindPath }) {
  const columnRef = useRef(null);
  useEffect(() => {
    if (selection?.kind === 'table' && selection.column) columnRef.current?.scrollIntoView({ block: 'center' });
  }, [selection]);
  if (!selection) return null;
  const tableById = new Map(graph.tables.map((table) => [table.id, table]));
  if (selection.kind === 'relationship') {
    const relationship = graph.relationships.find((item) => item.key === selection.id);
    if (!relationship) return null;
    const source = tableById.get(relationship.source);
    const target = tableById.get(relationship.target);
    return (
      <aside className="inspector" aria-label="Relationship details">
        <InspectorHeader eyebrow="Foreign key" title={`${displayName(source)} → ${displayName(target)}`} onClose={onClose} />
        <div className="inspector__body">
          <p className="inspector__lede">Rows in <strong>{displayName(source)}</strong> reference a row in <strong>{displayName(target)}</strong>.</p>
          <section className="inspector__section">
            <h3>Column mapping</h3>
            <div className="mapping-list">
              {relationship.columns.map(([from, to]) => <div className="mapping" key={`${from}-${to}`}><code>{from}</code><Icon name="arrow" size={16}/><code>{to}</code></div>)}
            </div>
          </section>
          <section className="inspector__section inspector__section--muted">
            <h3>Relationship ID</h3>
            <code className="identifier">{String(relationship.foreign_key_id || relationship.key)}</code>
          </section>
          <div className="endpoint-actions">
            <button type="button" onClick={() => onSelectTable(source.id)}><span>Inspect child</span><strong>{displayName(source)}</strong></button>
            <button type="button" onClick={() => onSelectTable(target.id)}><span>Inspect parent</span><strong>{displayName(target)}</strong></button>
          </div>
        </div>
      </aside>
    );
  }

  const table = tableById.get(selection.id);
  if (!table) return null;
  const connected = graph.relationships.filter((relationship) => relationship.source === table.id || relationship.target === table.id);
  const foreignColumns = new Set(graph.relationships.filter((relationship) => relationship.source === table.id).flatMap((relationship) => relationship.columns.map(([source]) => source.toLocaleLowerCase())));
  return (
    <aside className="inspector" aria-label="Table details">
      <InspectorHeader eyebrow={table.data_model_name || 'Table'} title={displayName(table)} onClose={onClose} />
      <div className="inspector__body">
        <div className="facts"><span><strong>{table.columns.length}</strong> columns</span><span><strong>{connected.length}</strong> relationships</span></div>
        <button className="path-start" type="button" onClick={() => onFindPath(table.id)}>Find connection to…</button>
        <section className="inspector__section">
          <h3>Columns</h3>
          <div className="inspector-columns">
            {table.columns.length ? table.columns.map((column) => {
              const key = markerFor(column, table, foreignColumns);
              const targeted = selection.column === column.name;
              return <div className={`inspector-column ${targeted ? 'is-search-target' : ''}`} ref={targeted ? columnRef : null} aria-current={targeted ? 'true' : undefined} key={column.name}><span><strong>{column.name}</strong><small>{column.type || 'Unknown type'}</small></span>{key && <span className="key-badge">{key}</span>}</div>;
            }) : <p className="empty-note">Run without <code>--include_columns=False</code> to load columns.</p>}
          </div>
        </section>
        <section className="inspector__section">
          <h3>Connected tables</h3>
          <div className="relation-list">
            {connected.length ? connected.map((relationship) => {
              const other = tableById.get(relationship.source === table.id ? relationship.target : relationship.source);
              const direction = relationship.source === table.id ? 'references' : 'referenced by';
              return <button type="button" key={relationship.key} onClick={() => onSelectTable(other.id)}><span>{direction}</span><strong>{displayName(other)}</strong><small>{relationship.label}</small></button>;
            }) : <p className="empty-note">This table has no configured foreign keys.</p>}
          </div>
        </section>
      </div>
    </aside>
  );
}

function InspectorHeader({ eyebrow, title, onClose }) {
  return <header className="inspector__header"><div><span>{eyebrow}</span><h2>{title}</h2></div><button type="button" onClick={onClose} aria-label="Close inspector"><Icon name="close"/></button></header>;
}

function Diagram({ graph, snapshot, offline, onImport }) {
  const [views] = useState(() => {
    const store = createViewStore();
    if (snapshot) {
      for (const [scope, view] of Object.entries(snapshot.views)) store.restore(graph, scope, view);
      store.saveScope(graph, snapshot.activeModel);
    }
    return store;
  });
  const [drafts] = useState(() => createDraftStore());
  const [queryOpen, setQueryOpen] = useState(true);
  const [queryHeight, setQueryHeight] = useState(320);
  const restoreScopeFocus = useRef(false);
  const models = useMemo(() => [...new Map(graph.tables.map((table) => [modelId(graph, table), table.data_model_name || graph.metadata.data_model_name || modelId(graph, table)])).entries()], [graph]);
  const [activeModel, setActiveModel] = useState(() => views.loadScope(graph));
  // Each scope owns its React Flow lifecycle, including pending viewport animations.
  return <ReactFlowProvider key={activeModel}><Explorer graph={graph} models={models} activeModel={activeModel} setActiveModel={setActiveModel} views={views}
    drafts={drafts} restoreScopeFocus={restoreScopeFocus} queryOpen={queryOpen} setQueryOpen={setQueryOpen} queryHeight={queryHeight} setQueryHeight={setQueryHeight}
    offline={offline} onImport={onImport}/></ReactFlowProvider>;
}

function Explorer({ graph, models, activeModel, setActiveModel, views, drafts, restoreScopeFocus, queryOpen, setQueryOpen, queryHeight, setQueryHeight, offline, onImport }) {
  const [savedView] = useState(() => views.load(graph, activeModel));
  const [selection, setSelection] = useState(null);
  const [pathOpen, setPathOpen] = useState(false);
  const [endpoints, setEndpoints] = useState({ from: '', to: '' });
  const [flow, setFlow] = useState(null);
  const searchFocusTimer = useRef(null);
  const viewReady = useRef(false);
  const scopeSelect = useRef(null);
  const canvasRef = useRef(null);
  const canvasPointer = useRef(null);
  useEffect(() => {
    if (restoreScopeFocus.current) {
      scopeSelect.current?.focus();
      restoreScopeFocus.current = false;
    }
  }, [restoreScopeFocus]);
  const nodesInitialized = useNodesInitialized();
  const selectTable = useCallback((id) => { setPathOpen(false); setSelection({ kind: 'table', id }); }, []);
  const built = useMemo(() => {
    const elements = buildElements(graph, activeModel, selectTable);
    return { ...elements, nodes: restorePositions(elements.nodes, savedView, NODE_WIDTH, HORIZONTAL_GAP) };
  }, [graph, activeModel, selectTable, savedView]);
  const startingTable = built.tables.find((table) => table.id === endpoints.from);
  const choosingDestination = pathOpen && Boolean(startingTable) && !endpoints.to;
  const path = useMemo(() => findPath(built.tables, built.relationships, endpoints.from, endpoints.to), [built, endpoints]);
  const [nodes, setNodes, onNodesChange] = useNodesState([
    ...built.nodes,
    ...(savedView?.notes ?? []).filter((note) => !built.nodes.some((node) => node.id === note.id)).map((note) => noteNode(note)),
  ]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  const saveView = useCallback(() => {
    if (viewReady.current && flow) views.save(graph, activeModel, flow.getNodes(), flow.getViewport());
  }, [flow, graph, activeModel, views]);

  const exportState = () => {
    saveView();
    const layouts = Object.fromEntries(models.map(([scope]) => {
      const saved = views.load(graph, scope);
      const tables = graph.tables.filter(table => modelId(graph, table) === scope);
      // Include deterministic positions even for models that have never been opened.
      const positions = saved && tables.every(table => Object.hasOwn(saved.positions, table.id))
        ? Object.fromEntries(tables.map(table => [table.id, saved.positions[table.id]]))
        : Object.fromEntries(restorePositions(buildElements(graph, scope, selectTable).nodes, saved, NODE_WIDTH, HORIZONTAL_GAP)
          .map(node => [node.id, node.position]));
      return [scope, { version: 1, positions, viewport: saved?.viewport ?? null, notes: saved?.notes ?? [] }];
    }));
    return createDatapoolState(graph, activeModel, layouts);
  };

  // Text edits, additions, and deletions are saved as well as drag/zoom changes.
  // Scope changes and pagehide flush immediately through saveView.
  useEffect(() => {
    const timer = setTimeout(saveView, 150);
    return () => clearTimeout(timer);
  }, [nodes, saveView]);

  const addNote = useCallback((pointer = null) => {
    if (!flow || !canvasRef.current) return;
    const bounds = canvasRef.current.getBoundingClientRect();
    if (pointer && (pointer.x < bounds.left || pointer.x > bounds.right || pointer.y < bounds.top || pointer.y > bounds.bottom)) return;
    const point = flow.screenToFlowPosition(pointer ?? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 });
    const position = { x: point.x - NOTE_WIDTH / 2, y: point.y - NOTE_HEIGHT / 2 };
    const note = { id: `note:${crypto.randomUUID()}`, text: '', position };
    setNodes((current) => [...current, noteNode(note, true)]);
  }, [flow, setNodes]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
        || event.repeat || event.isComposing || event.defaultPrevented || !canvasPointer.current) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]'))) return;
      event.preventDefault();
      addNote(canvasPointer.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addNote]);

  const changeModel = (id) => {
    if (id === activeModel) return;
    restoreScopeFocus.current = document.activeElement === scopeSelect.current;
    saveView();
    viewReady.current = false;
    views.saveScope(graph, id);
    setActiveModel(id);
  };

  useEffect(() => {
    if (viewReady.current || !flow || (!nodesInitialized && built.nodes.length)) return;
    let cancelled = false;
    const restore = async () => {
      if (savedView?.viewport) await flow.setViewport(savedView.viewport);
      else await flow.fitView({ padding: 0.15, maxZoom: 1 });
      if (!cancelled) viewReady.current = true;
    };
    void restore();
    return () => { cancelled = true; };
  }, [flow, nodesInitialized, built, savedView]);

  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') saveView(); };
    window.addEventListener('pagehide', saveView);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', saveView);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [saveView]);

  const chooseDestination = useCallback((id) => {
    setEndpoints((current) => id === current.from ? current : { ...current, to: id });
  }, []);

  const closePath = useCallback(() => {
    setPathOpen(false);
    setSelection(endpoints.from ? { kind: 'table', id: endpoints.from } : null);
    setEndpoints({ from: '', to: '' });
  }, [endpoints.from]);

  useEffect(() => {
    setEndpoints({ from: '', to: '' });
    setPathOpen(false);
  }, [activeModel]);

  const fitPath = useCallback(() => {
    if (path) flow?.fitView({ nodes: path.tableIds.map((id) => ({ id })), padding: 0.25, duration: 500, maxZoom: 1.2 });
  }, [flow, path]);

  useEffect(() => {
    if (!pathOpen || (!choosingDestination && !path)) return;
    // Wait for the inspector's canvas resize before fitting the route.
    const timer = setTimeout(() => {
      if (choosingDestination) flow?.fitView({ padding: 0.25, duration: 500, maxZoom: 1 });
      else fitPath();
    }, 280);
    return () => clearTimeout(timer);
  }, [pathOpen, path, fitPath, choosingDestination, flow]);

  const openPath = (from) => {
    clearTimeout(searchFocusTimer.current);
    setEndpoints({ from, to: '' });
    setSelection(null);
    setPathOpen(true);
  };

  useEffect(() => {
    const connectedNodes = new Set();
    const connectedEdges = new Set();
    const tracingPath = pathOpen && !choosingDestination;
    if (pathOpen) {
      (path?.tableIds || [endpoints.from, endpoints.to].filter(Boolean)).forEach((id) => connectedNodes.add(id));
      path?.steps.forEach((step) => connectedEdges.add(step.relationship.key));
    } else if (selection?.kind === 'table') {
      connectedNodes.add(selection.id);
      built.relationships.forEach((relationship) => {
        if (relationship.source === selection.id || relationship.target === selection.id) {
          connectedNodes.add(relationship.source);
          connectedNodes.add(relationship.target);
          connectedEdges.add(relationship.key);
        }
      });
    } else if (selection?.kind === 'relationship') {
      const relationship = built.relationships.find((item) => item.key === selection.id);
      if (relationship) {
        connectedNodes.add(relationship.source);
        connectedNodes.add(relationship.target);
        connectedEdges.add(relationship.key);
      }
    }
    setNodes((current) => current.map((node) => node.type === 'stickyNote' ? node : ({ ...node, data: { ...node.data, onSelectTable: choosingDestination ? chooseDestination : selectTable, choosingDestination, isSelected: pathOpen ? connectedNodes.has(node.id) : selection?.kind === 'table' && node.id === selection.id, isDimmed: (tracingPath || Boolean(selection)) && !connectedNodes.has(node.id) } })));
    setEdges((current) => current.map((edge) => {
      const active = connectedEdges.has(edge.id);
      return { ...edge, animated: active, className: `${active ? 'is-active' : ''} ${(tracingPath || selection) && !active ? 'is-dimmed' : ''}`, label: selection?.kind === 'relationship' && edge.id === selection.id ? edge.data.relationship.label : undefined };
    }));
  }, [selection, built.relationships, pathOpen, path, endpoints, choosingDestination, chooseDestination, selectTable, setEdges, setNodes]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (pathOpen) closePath();
        else setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pathOpen, closePath]);

  useEffect(() => {
    const timer = searchFocusTimer.current;
    return () => clearTimeout(timer);
  }, [selection, pathOpen]);

  const focusResult = (result) => {
    if (choosingDestination) { chooseDestination(result.table.id); return; }
    setPathOpen(false);
    setSelection({ kind: 'table', id: result.table.id, column: result.column });
    clearTimeout(searchFocusTimer.current);
    // Fit after the inspector has resized the canvas.
    searchFocusTimer.current = setTimeout(() => {
      flow?.fitView({ nodes: [{ id: result.table.id }], padding: 0.8, duration: 650, maxZoom: 1.25 });
    }, 280);
  };

  const title = graph.metadata.data_pool_name || graph.metadata.data_model_name || 'Celonis data model';
  return (
    <main className={`app-shell ${offline ? '' : 'has-query-panel'} ${selection || pathOpen ? 'has-inspector' : ''}`} style={{ '--query-height': queryOpen ? `min(${queryHeight}px, 60dvh)` : '42px' }}>
      <header className="topbar">
        <div className="brand"><span className="brand__mark" aria-hidden="true"><span></span><span></span><span></span></span><div><span>ERD Explorer</span><h1 title={title}>{title}</h1></div></div>
        <label className="scope-control">
          <Icon name="layers" size={16}/>
          <span className="scope-control__field"><span>Data model</span>
            <select ref={scopeSelect} aria-label="Data model scope" value={activeModel} onChange={(event) => changeModel(event.target.value)} title={models.find(([id]) => id === activeModel)?.[1]}>
              {models.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </span>
          <Icon name="chevron" size={16}/>
        </label>
        <StateTransfer onImport={snapshot => { saveView(); onImport(snapshot); }} onExport={flow ? exportState : null}/>
        <div className="topbar__stats"><span><strong>{built.tables.length}</strong> tables</span><span><strong>{built.relationships.length}</strong> relations</span></div>
        <Search tables={built.tables} onSelect={focusResult} shortcut={!choosingDestination} tableOnlyToggle={!choosingDestination} onCancel={choosingDestination ? closePath : undefined}/>
      </header>
      <section ref={canvasRef} className="canvas" aria-label="Entity relationship diagram"
        onPointerMove={(event) => { canvasPointer.current = { x: event.clientX, y: event.clientY }; }}
        onPointerEnter={(event) => { canvasPointer.current = { x: event.clientX, y: event.clientY }; }}
        onPointerLeave={() => { canvasPointer.current = null; }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setFlow}
          onNodeDragStop={saveView}
          onSelectionDragStop={saveView}
          onMoveEnd={saveView}
          onPaneClick={() => setSelection(null)}
          onNodeClick={(event, node) => { if (node.type === 'tableCard' && choosingDestination && !event.target.closest('button')) chooseDestination(node.id); }}
          onEdgeClick={(_event, edge) => { if (!choosingDestination) { setPathOpen(false); setSelection({ kind: 'relationship', id: edge.id }); } }}
          defaultViewport={savedView?.viewport ?? { x: 0, y: 0, zoom: 1 }}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#c7cfcc" gap={24} size={1} />
          <MiniMap nodeColor={(node) => node.type === 'stickyNote' ? '#f3d778' : node.data.isDimmed ? '#c9cfcc' : '#86bd67'} maskColor="rgba(238, 242, 241, .78)" pannable zoomable />
          <Controls showInteractive={false} />
          <Panel position="top-right"><button type="button" className="add-note" onClick={() => addNote()} disabled={!flow}
            title="Add note (N at pointer on canvas)" aria-label="Add sticky note" aria-keyshortcuts="N">
            <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 3h14a2 2 0 0 1 2 2v10l-6 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="#ffe9a0" />
              <path d="M21 15h-4a2 2 0 0 0-2 2v4M7 8h10M7 12h7" />
            </svg><kbd aria-hidden="true">N</kbd>
          </button></Panel>
          {choosingDestination ? <div className="canvas-prompt" role="status">Choose a table to connect with <strong>{displayName(startingTable)}</strong><button type="button" onClick={closePath}>Cancel</button></div> : <div className="canvas-legend"><span><i className="dot dot--pk"></i>Primary key</span><span><i className="dot dot--fk"></i>Foreign key</span></div>}
        </ReactFlow>
      </section>
      {!offline && <QueryPanel poolId={graph.metadata.data_pool_id} modelId={activeModel} modelName={models.find(([id]) => id === activeModel)?.[1] || activeModel}
        tables={built.tables} drafts={drafts} open={queryOpen} height={queryHeight} onToggle={() => setQueryOpen(value => !value)}
        onResize={height => setQueryHeight(Math.max(220, Math.min(650, height)))}/>}
      {pathOpen ? <PathFinder tables={built.tables} from={endpoints.from} to={endpoints.to} onDestination={chooseDestination} onChangeDestination={() => setEndpoints((current) => ({ ...current, to: '' }))} result={path} onClose={closePath} onFit={fitPath} /> : <DetailPanel selection={selection} graph={graph} onClose={() => setSelection(null)} onFindPath={openPath} onSelectTable={(id) => { selectTable(id); flow?.fitView({ nodes: [{ id }], padding: 0.7, duration: 500, maxZoom: 1.2 }); }} />}
    </main>
  );
}

function App() {
  const [state, setState] = useState({ loading: true, graph: null, error: null, revision: 0 });
  const importState = snapshot => {
    const remembered = rememberImportedGraph(snapshot.graph);
    setState(current => ({ loading: false, graph: snapshot.graph, snapshot, offline: true, error: null,
      revision: current.revision + 1, storageWarning: !remembered }));
  };
  useEffect(() => {
    fetch('/api/graph').then((response) => {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      return response.json();
    }).then((graph) => setState({ loading: false, graph: graph ?? loadImportedGraph(), offline: !graph, error: null, revision: 0 }))
      .catch((error) => setState({ loading: false, graph: null, error: error.message, revision: 0 }));
  }, []);
  if (state.loading) return <div className="state-screen"><span className="loader"></span><h1>Arranging the data model</h1><p>Placing tables and tracing foreign keys…</p></div>;
  if (state.error) return <div className="state-screen state-screen--error"><h1>The model could not be loaded</h1><p>{state.error}. Check the terminal that started this server, then refresh.</p><button type="button" onClick={() => window.location.reload()}>Try again</button></div>;
  if (!state.graph) return <main className="app-shell">
    <header className="topbar"><div className="brand"><h1>ERD Explorer</h1></div><StateTransfer onImport={importState}/></header>
    <div className="state-screen"><h1>Open a saved datapool</h1><p>Choose Import datapool above to restore tables, relationships, layouts, and sticky notes.</p><p>No Celonis connection is needed.</p></div>
  </main>;
  return <><Diagram key={state.revision} graph={state.graph} snapshot={state.snapshot} offline={state.offline} onImport={importState}/>
    {state.storageWarning && <div className="storage-warning" role="status">Browser storage is unavailable or full. Export your work before closing this page.</div>}</>;
}

createRoot(document.getElementById('root')).render(<App />);
