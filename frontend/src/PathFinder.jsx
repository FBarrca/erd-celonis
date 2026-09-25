import React, { useMemo } from 'react';
import Search from './Search.jsx';

const nameOf = (table) => table.alias || table.name || String(table.table_id || table.id);
const qualifiedColumn = (table, column) => [nameOf(table), column].map((part) => `"${String(part).replaceAll('"', '""')}"`).join('.');

export default function PathFinder({ tables, from, to, onDestination, onChangeDestination, result, onClose, onFit }) {
  const destinations = useMemo(() => tables.filter((table) => table.id !== from), [tables, from]);
  const tableById = useMemo(() => new Map(tables.map((table) => [table.id, table])), [tables]);
  const source = tableById.get(from);
  const ready = tableById.has(from) && tableById.has(to);
  if (!source) return null;

  return (
    <aside className="inspector path-finder" aria-label="Table connection">
      <header className="inspector__header">
        <div><span>Connection from · {source.data_model_name || 'Data model'}</span><h2>{nameOf(source)}</h2></div>
        <button type="button" onClick={onClose} aria-label="Close connection">✕</button>
      </header>
      <div className="inspector__body">
        {!ready ? <>
          <p className="inspector__lede">Choose a table to connect with <strong>{nameOf(source)}</strong>. Search by table or column, or click another table on the diagram.</p>
          <Search tables={destinations} onSelect={(item) => onDestination(item.table.id)} placeholder="Search destination table or column" shortcut autoFocus onCancel={onClose} variant="destination" actionLabel="Connect"/>
        </> : <div className="path-destination"><span>To · {tableById.get(to).data_model_name || 'Data model'}</span><strong>{nameOf(tableById.get(to))}</strong></div>}
        <div className="path-actions">
          {ready && <button type="button" onClick={onChangeDestination}>Change destination</button>}
          <button type="button" onClick={onClose}>{ready ? 'Clear route' : 'Cancel'}</button>
          {result && <button type="button" onClick={onFit}>Fit route</button>}
        </div>
        {ready && <div className="path-status" role="status">
          {!result ? (
            <><strong>No path found</strong><p>No chain of configured relationships connects {nameOf(tableById.get(from))} and {nameOf(tableById.get(to))} in the loaded model scope. A relationship may be missing or the tables may belong to separate models.</p></>
          ) : result.steps.length === 0 ? (
            <><strong>Same table selected</strong><p>Both endpoints are {nameOf(tableById.get(from))}. No joins are needed.</p></>
          ) : (
            <><strong>{result.steps.length} {result.steps.length === 1 ? 'relationship' : 'relationships'} · {result.tableIds.length} tables</strong><p>One shortest route is highlighted on the diagram.</p></>
          )}
        </div>}
        {result && result.steps.length > 0 && <>
          <section className="inspector__section">
            <h3>Table route</h3>
            <ol className="path-tables">{result.tableIds.map((id) => <li key={id}>{nameOf(tableById.get(id))}</li>)}</ol>
          </section>
          <section className="inspector__section">
            <h3>Join columns</h3>
            <ol className="path-steps">{result.steps.map((step, index) => (
              <li key={step.relationship.key}>
                <h4>{index + 1}. {nameOf(tableById.get(step.from))} → {nameOf(tableById.get(step.to))}</h4>
                {step.columns.length ? <div className="path-joins">{step.columns.map(([left, right], pairIndex) => (
                  <div className="path-join" key={pairIndex}>
                    {pairIndex > 0 && <small>AND</small>}
                    <code>{qualifiedColumn(tableById.get(step.from), left)}</code>
                    <span>=</span>
                    <code>{qualifiedColumn(tableById.get(step.to), right)}</code>
                  </div>
                ))}</div> : <p className="empty-note">Column mappings are unavailable for this relationship.</p>}
              </li>
            ))}</ol>
          </section>
        </>}
      </div>
    </aside>
  );
}
