import React, { useMemo } from 'react';

const nameOf = (table) => table.alias || table.name || String(table.table_id || table.id);
const qualifiedColumn = (table, column) => [nameOf(table), column].map((part) => `"${String(part).replaceAll('"', '""')}"`).join('.');

export default function PathFinder({ tables, from, to, onChange, result, onClose, onFit }) {
  const sorted = useMemo(() => [...tables].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.id.localeCompare(b.id)), [tables]);
  const tableById = useMemo(() => new Map(tables.map((table) => [table.id, table])), [tables]);
  const names = useMemo(() => {
    const counts = new Map();
    tables.forEach((table) => counts.set(nameOf(table), (counts.get(nameOf(table)) || 0) + 1));
    return counts;
  }, [tables]);
  const ready = tableById.has(from) && tableById.has(to);
  const optionLabel = (table) => names.get(nameOf(table)) > 1
    ? `${nameOf(table)} — ${table.data_model_name || 'Data model'} (${table.id})`
    : nameOf(table);

  return (
    <aside className="inspector path-finder" aria-label="Find a path between tables">
      <header className="inspector__header">
        <div><span>Explore connections</span><h2>Find a path</h2></div>
        <button type="button" onClick={onClose} aria-label="Close path finder">✕</button>
      </header>
      <div className="inspector__body">
        <p className="inspector__lede">Choose two tables to trace their shortest route through configured relationships, in either direction.</p>
        <div className="path-selectors">
          {[['From table', from, (value) => onChange(value, to)], ['To table', to, (value) => onChange(from, value)]].map(([label, value, change]) => (
            <label key={label}>{label}
              <select value={value} onChange={(event) => change(event.target.value)}>
                <option value="">Choose a table…</option>
                {sorted.map((table) => <option key={table.id} value={table.id}>{optionLabel(table)}</option>)}
              </select>
            </label>
          ))}
        </div>
        <div className="path-actions">
          <button type="button" onClick={() => onChange(to, from)} disabled={!from && !to}>Swap tables</button>
          <button type="button" onClick={() => onChange('', '')} disabled={!from && !to}>Clear</button>
          {result && <button type="button" onClick={onFit}>Fit route</button>}
        </div>
        <div className="path-status" role="status">
          {!ready ? 'Select a From and To table to find a path.' : !result ? (
            <><strong>No path found</strong><p>No chain of configured relationships connects {nameOf(tableById.get(from))} and {nameOf(tableById.get(to))} in the loaded model scope. A relationship may be missing or the tables may belong to separate models.</p></>
          ) : result.steps.length === 0 ? (
            <><strong>Same table selected</strong><p>Both endpoints are {nameOf(tableById.get(from))}. No joins are needed.</p></>
          ) : (
            <><strong>{result.steps.length} {result.steps.length === 1 ? 'relationship' : 'relationships'} · {result.tableIds.length} tables</strong><p>One shortest route is highlighted on the diagram.</p></>
          )}
        </div>
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
