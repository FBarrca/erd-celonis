import React, { useEffect, useMemo, useRef, useState } from 'react';
import Search from './Search.jsx';
import PqlEditor from './PqlEditor.jsx';
import { createPqlCompletionIndex } from './pqlLanguage.js';
import { pqlReference, resultCsv } from './queryDrafts.js';
import { exampleScript, MAX_SCRIPT_LENGTH, parsePqlScript, scriptFromDraft } from './pqlScript.js';
import './queryPanel.css';

const PAGE_SIZE = 100;

function PanelIcon({ kind }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'expand' ? <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>
      : kind === 'restore' ? <path d="M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5"/>
        : <path d={kind === 'open' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'}/>}
  </svg>;
}

export default function QueryPanel({ poolId, modelId, modelName, tables, drafts, open, height, onToggle, onResize }) {
  const [draft, setDraft] = useState(() => {
    const saved = drafts.load(poolId, modelId);
    return { ...saved, script: scriptFromDraft(saved) };
  });
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [resultsHeight, setResultsHeight] = useState(250);
  const requestRef = useRef(null);
  const editorRef = useRef(null);
  const resizeRef = useRef(null);
  const resultsResizeRef = useRef(null);
  const completionIndex = useMemo(() => createPqlCompletionIndex(tables), [tables]);
  const parsed = useMemo(() => {
    try { return { query: parsePqlScript(draft.script, draft.limit), error: '' }; }
    catch (failure) { return { query: null, error: failure.message }; }
  }, [draft.script, draft.limit]);

  useEffect(() => () => requestRef.current?.abort(), []);
  const edit = next => {
    setDraft(next);
    drafts.save(poolId, modelId, next);
    setNotice('');
  };
  const insertText = (text, atStart = false) => {
    const editor = editorRef.current;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    if (editor.state.doc.length - (atStart ? 0 : to - from) + text.length > MAX_SCRIPT_LENGTH) {
      setNotice('Queries are limited to 65,536 characters.'); return;
    }
    editor.dispatch({ changes: { from: atStart ? 0 : from, to: atStart ? 0 : to, insert: text },
      selection: atStart ? { anchor: 7, head: text.indexOf(';') } : { anchor: from + text.length }, userEvent: 'input' });
    editor.focus();
  };
  const run = async () => {
    if (requestRef.current) return;
    if (parsed.error) { setError(parsed.error); return; }
    const { limitFromScript, ...query } = parsed.query;
    const body = JSON.stringify({ model_id: modelId, ...query });
    if (new TextEncoder().encode(body).length > 128 * 1024) { setError('This query exceeds the 128 KB request limit. Shorten the expressions or filters.'); return; }
    const controller = new AbortController();
    requestRef.current = controller;
    const submitted = structuredClone(draft);
    setRunning(true); setError(''); setResult(null); setPage(0); setSort(null); setNotice('');
    try {
      // Refresh the session for each run so a server restart needs no page reload.
      const configResponse = await fetch('/api/query-config', { signal: controller.signal });
      const config = await configResponse.json();
      if (!configResponse.ok) throw new Error(config.error || 'Could not open a query session.');
      if (!config.enabled) throw new Error('Query execution is unavailable. Start the explorer with the Celonis CLI.');
      const response = await fetch('/api/query', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Query-Token': config.token },
        body, signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Query failed (${response.status}).`);
      if (!controller.signal.aborted) setResult({ ...data, draft: submitted });
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Could not reach the query server.');
    } finally {
      if (!controller.signal.aborted) { setRunning(false); requestRef.current = null; }
    }
  };
  const rows = useMemo(() => {
    if (!result) return [];
    if (!sort) return result.rows;
    return [...result.rows].sort((a, b) => {
      const left = a[sort.index], right = b[sort.index];
      const order = left == null ? (right == null ? 0 : 1) : right == null ? -1
        : typeof left === 'number' && typeof right === 'number' ? left - right
          : String(left).localeCompare(String(right), undefined, { numeric: true });
      return sort.desc ? -order : order;
    });
  }, [result, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob(['\uFEFF', resultCsv(result)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'pql-results.csv';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stale = result && JSON.stringify(result.draft) !== JSON.stringify(draft);
  const resizeResults = nextHeight => setResultsHeight(Math.max(46, Math.min(650, nextHeight)));
  return <section className={`query-panel ${open ? 'is-open' : ''} ${expanded && open ? 'is-expanded' : ''}`} aria-label="PQL query panel"
    onKeyDown={event => { if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void run(); } }}>
    {open && !expanded && <div className="query-resize" role="separator" aria-label="Resize PQL panel" aria-orientation="horizontal" tabIndex={0}
      aria-valuemin={220} aria-valuemax={650} aria-valuenow={height}
      onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onResize(height + (event.key === 'ArrowUp' ? 30 : -30)); } }}
      onPointerDown={event => { resizeRef.current = { y: event.clientY, height }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (resizeRef.current) onResize(resizeRef.current.height + resizeRef.current.y - event.clientY); }}
      onPointerUp={() => { resizeRef.current = null; }} onPointerCancel={() => { resizeRef.current = null; }}/>}
    <header className="query-header">
      <strong className="query-title">PQL console</strong>
      <span className="query-model" title={modelName}>{modelName}</span>
      <span className="query-header-status" role="status">{running ? 'Running query…' : result ? `${result.row_count.toLocaleString()} rows · ${(result.elapsed_ms / 1000).toFixed(2)} s` : 'Ready'}</span>
      <div className="query-window-controls">
        {open && <button className="query-icon-button" type="button" aria-label={expanded ? 'Restore console size' : 'Expand console'} title={expanded ? 'Restore console size' : 'Expand console'} onClick={() => setExpanded(!expanded)}><PanelIcon kind={expanded ? 'restore' : 'expand'}/></button>}
        <button className="query-icon-button" type="button" aria-label={open ? 'Collapse PQL console' : 'Open PQL console'} title={open ? 'Collapse PQL console' : 'Open PQL console'} aria-expanded={open} aria-controls="query-body" onClick={onToggle}><PanelIcon kind={open ? 'close' : 'open'}/></button>
      </div>
    </header>
    <div className="query-body" id="query-body" hidden={!open}>
      <div className="query-toolbar">
        <button type="button" className="query-run" disabled={running} onClick={() => void run()}>{running ? 'Running…' : '▶ Run'} <kbd>Ctrl / ⌘ ↵</kbd></button>
        <label>Row limit <input type="number" min={1} max={10000} aria-label="Query row limit" disabled={Boolean(parsed.query?.limitFromScript)} title={parsed.query?.limitFromScript ? 'Set by LIMIT in the query' : 'Maximum returned rows'} value={parsed.query?.limitFromScript ? parsed.query.limit : draft.limit || ''} onChange={e => edit({ ...draft, limit: Number(e.target.value) })}/></label>
        <button type="button" onClick={() => insertText('FILTER condition;\n\n', true)}>+ Filter</button>
        <Search tables={tables} onSelect={item => insertText(pqlReference(item))} placeholder="Insert table or column" shortcut={false} variant="pql" actionLabel="Insert"/>
      </div>
      <div className="query-editor">
        <div className="query-editor-heading"><span>QUERY <small>PQL</small></span><span>{parsed.query ? `${parsed.query.columns.length} columns · ${parsed.query.filters.length} filters` : 'TABLE expressions + FILTER statements'} <button type="button" onClick={() => {
          const editor = editorRef.current;
          editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: exampleScript(tables[0]) }, userEvent: 'input' }); editor.focus();
        }}>Load example</button></span></div>
        <PqlEditor consoleMode isFilter maxLength={MAX_SCRIPT_LENGTH} label="PQL query" placeholder="Write a TABLE query…" value={draft.script}
          register={editor => { editorRef.current = editor; }} completionIndex={completionIndex} onChange={script => edit({ ...draft, script })} onRun={() => void run()}/>
      </div>
      <div className="query-messages">
        {notice && <p className="query-note" role="status">{notice}</p>}
      </div>
      <div className="query-results-resize" role="separator" aria-label="Resize PQL results" aria-orientation="horizontal"
        aria-valuemin={46} aria-valuemax={650} aria-valuenow={resultsHeight} tabIndex={0}
        onKeyDown={event => { if (['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); resizeResults(resultsHeight + (event.key === 'ArrowUp' ? 30 : -30)); } }}
        onPointerDown={event => { resultsResizeRef.current = { y: event.clientY, height: resultsHeight }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => { if (resultsResizeRef.current) resizeResults(resultsResizeRef.current.height + resultsResizeRef.current.y - event.clientY); }}
        onPointerUp={() => { resultsResizeRef.current = null; }} onPointerCancel={() => { resultsResizeRef.current = null; }} />
      <div className="query-results" style={{ '--query-results-height': `${resultsHeight}px` }} aria-busy={running}>
        <div className="query-results-toolbar"><strong>RESULTS</strong><span>{result ? `${result.row_count.toLocaleString()} rows · ${(result.elapsed_ms / 1000).toFixed(2)} s` : 'DataFrame'}</span>{result && <button type="button" onClick={exportCsv}>Download CSV</button>}</div>
        {error && <pre className="query-error" role="alert">{error}</pre>}
        {!result && !error && <div className="query-empty"><strong>{running ? 'Executing in Celonis…' : 'Run a query to see results'}</strong><p>{running ? 'You can keep exploring the diagram. Switching models stops waiting; the server query may still finish.' : 'Ctrl / ⌘ + Enter · Results stay in this session'}</p></div>}
        {result && <>
          {(stale || result.limit_reached) && <p className="query-note">{stale && 'Showing the previous run. Run again to apply your edits. '}{result.limit_reached && `Reached the ${result.limit.toLocaleString()}-row limit; more rows may exist.`}</p>}
          <div className="query-grid" tabIndex={0} aria-label="Query result rows">
            <table><thead><tr>{result.columns.map((column, index) => <th key={index} aria-sort={sort?.index === index ? (sort.desc ? 'descending' : 'ascending') : 'none'}><button type="button" title={`${column.dtype} · Sort returned rows`} onClick={() => { setSort({ index, desc: sort?.index === index && !sort.desc }); setPage(0); }}>{column.name}{sort?.index === index ? sort.desc ? ' ↓' : ' ↑' : ''}<small>{column.dtype}</small></button></th>)}</tr></thead>
              <tbody>{rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value === null ? <span className="query-null">NULL</span> : String(value)}</td>)}</tr>)}</tbody></table>
            {!rows.length && <p className="query-note">The query returned no rows.</p>}
          </div>
          <div className="query-pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page + 1} of {pages} · {PAGE_SIZE} rows per page</span><button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button></div>
        </>}
      </div>
    </div>
  </section>;
}
