import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import dagre from '@dagrejs/dagre';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';

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
    focus: <><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="3"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
    download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function displayName(table) {
  return table.alias || table.name || String(table.table_id || table.id);
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
    <article className={`table-card ${data.isSelected ? 'is-selected' : ''} ${data.isDimmed ? 'is-dimmed' : ''}`}>
      <Handle type="source" position={Position.Top} className="table-handle table-handle--main" />
      <Handle type="target" position={Position.Bottom} className="table-handle table-handle--main" />
      <button className="table-card__header" type="button" onClick={() => data.onSelectTable(table.id)} aria-label={`Inspect ${displayName(table)}`}>
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

const nodeTypes = { tableCard: TableCard };

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
  const tables = activeModel === 'all' ? graph.tables : graph.tables.filter((table) => String(table.data_model_id) === activeModel);
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

function DetailPanel({ selection, graph, onClose, onSelectTable }) {
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
        <section className="inspector__section">
          <h3>Columns</h3>
          <div className="inspector-columns">
            {table.columns.length ? table.columns.map((column) => {
              const key = markerFor(column, table, foreignColumns);
              return <div className="inspector-column" key={column.name}><span><strong>{column.name}</strong><small>{column.type || 'Unknown type'}</small></span>{key && <span className="key-badge">{key}</span>}</div>;
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

function Explorer({ graph }) {
  const models = useMemo(() => [...new Map(graph.tables.map((table) => [String(table.data_model_id), table.data_model_name || table.data_model_id])).entries()], [graph]);
  const [activeModel, setActiveModel] = useState(models.length === 1 ? models[0][0] : 'all');
  const [selection, setSelection] = useState(null);
  const [query, setQuery] = useState('');
  const [flow, setFlow] = useState(null);
  const searchRef = useRef(null);
  const selectTable = useCallback((id) => setSelection({ kind: 'table', id }), []);
  const built = useMemo(() => buildElements(graph, activeModel, selectTable), [graph, activeModel, selectTable]);
  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  useEffect(() => {
    setSelection(null);
    setNodes(built.nodes);
    setEdges(built.edges);
    requestAnimationFrame(() => flow?.fitView({ padding: 0.15, duration: 500, maxZoom: 1 }));
  }, [built, flow, setEdges, setNodes]);

  useEffect(() => {
    const connectedNodes = new Set();
    const connectedEdges = new Set();
    if (selection?.kind === 'table') {
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
    setNodes((current) => current.map((node) => ({ ...node, data: { ...node.data, isSelected: selection?.kind === 'table' && node.id === selection.id, isDimmed: Boolean(selection) && !connectedNodes.has(node.id) } })));
    setEdges((current) => current.map((edge) => {
      const active = connectedEdges.has(edge.id);
      return { ...edge, animated: active, className: `${active ? 'is-active' : ''} ${selection && !active ? 'is-dimmed' : ''}`, label: selection?.kind === 'relationship' && edge.id === selection.id ? edge.data.relationship.label : undefined };
    }));
  }, [selection, built.relationships, setEdges, setNodes]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') { setSelection(null); setQuery(''); }
      if (event.key === '/' && document.activeElement !== searchRef.current) { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return built.tables.filter((table) => [displayName(table), table.name, ...table.columns.map((column) => column.name)].some((value) => String(value || '').toLocaleLowerCase().includes(normalized))).slice(0, 8);
  }, [built.tables, query]);

  const focusTable = (table) => {
    selectTable(table.id);
    setQuery('');
    flow?.fitView({ nodes: [{ id: table.id }], padding: 0.8, duration: 650, maxZoom: 1.25 });
  };

  const title = graph.metadata.data_pool_name || graph.metadata.data_model_name || 'Celonis data model';
  return (
    <main className={`app-shell ${selection ? 'has-inspector' : ''}`}>
      <header className="topbar">
        <div className="brand"><span className="brand__mark"><span></span><span></span><span></span></span><div><span>ERD explorer</span><h1>{title}</h1></div></div>
        <div className="topbar__stats"><span><strong>{built.tables.length}</strong> tables</span><span><strong>{built.relationships.length}</strong> relations</span></div>
        <a className="topbar__export" href="/api/graph.json" download="erd-celonis.json" title="Export the data model as JSON" aria-label="Export the data model as JSON"><Icon name="download" size={16}/><span className="topbar__export-label">Export JSON</span></a>
        <div className="search-wrap">
          <Icon name="search" size={17}/>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find table or column" aria-label="Find table or column" />
          <kbd>/</kbd>
          {results.length > 0 && <div className="search-results">{results.map((table) => <button type="button" key={table.id} onClick={() => focusTable(table)}><Icon name="table" size={15}/><span><strong>{displayName(table)}</strong><small>{table.data_model_name}</small></span></button>)}</div>}
        </div>
      </header>
      <nav className="model-bar" aria-label="Data model filter">
        <Icon name="layers" size={16}/><span className="model-bar__label">Scope</span>
        {models.length > 1 && <button type="button" className={activeModel === 'all' ? 'is-active' : ''} onClick={() => setActiveModel('all')}>All models</button>}
        {models.map(([id, name]) => <button type="button" key={id} className={activeModel === id ? 'is-active' : ''} onClick={() => setActiveModel(id)}>{name}</button>)}
        <span className="model-bar__hint">Select a table to trace its neighborhood</span>
      </nav>
      <section className="canvas" aria-label="Entity relationship diagram">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onInit={setFlow}
          onPaneClick={() => setSelection(null)}
          onEdgeClick={(_event, edge) => setSelection({ kind: 'relationship', id: edge.id })}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.08}
          maxZoom={2}
          panOnScroll
          zoomOnScroll={false}
          zoomOnPinch
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#c7cfcc" gap={24} size={1} />
          <MiniMap nodeColor={(node) => node.data.isDimmed ? '#c9cfcc' : '#86bd67'} maskColor="rgba(238, 242, 241, .78)" pannable zoomable />
          <Controls showInteractive={false} />
          <div className="canvas-legend"><span><i className="dot dot--pk"></i>Primary key</span><span><i className="dot dot--fk"></i>Foreign key</span><span><Icon name="focus" size={14}/>Drag or two-finger pan · pinch zoom</span></div>
        </ReactFlow>
      </section>
      <DetailPanel selection={selection} graph={graph} onClose={() => setSelection(null)} onSelectTable={(id) => { selectTable(id); flow?.fitView({ nodes: [{ id }], padding: 0.7, duration: 500, maxZoom: 1.2 }); }} />
    </main>
  );
}

function App() {
  const [state, setState] = useState({ loading: true, graph: null, error: null });
  useEffect(() => {
    fetch('/api/graph').then((response) => {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      return response.json();
    }).then((graph) => setState({ loading: false, graph, error: null })).catch((error) => setState({ loading: false, graph: null, error: error.message }));
  }, []);
  if (state.loading) return <div className="state-screen"><span className="loader"></span><h1>Arranging the data model</h1><p>Placing tables and tracing foreign keys…</p></div>;
  if (state.error) return <div className="state-screen state-screen--error"><h1>The model could not be loaded</h1><p>{state.error}. Check the terminal that started this server, then refresh.</p><button type="button" onClick={() => window.location.reload()}>Try again</button></div>;
  return <ReactFlowProvider><Explorer graph={state.graph}/></ReactFlowProvider>;
}

createRoot(document.getElementById('root')).render(<App />);
