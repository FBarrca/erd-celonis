import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createSearchIndex, normalizeLabel, searchIndex } from './search.js';

function Highlight({ text, ranges = [] }) {
  const parts = [];
  let cursor = 0;
  ranges.forEach(([start, end]) => {
    parts.push(text.slice(cursor, start), <mark key={start}>{text.slice(start, end + 1)}</mark>);
    cursor = end + 1;
  });
  parts.push(text.slice(cursor));
  return parts;
}

function ResultIcon({ kind }) {
  return <svg className="icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2"/>
    {kind === 'table' ? <path d="M3 9h18M8 9v11"/> : <><path d="M9 4v16M15 4v16"/><path d="M10 5h4v14h-4z" fill="currentColor" opacity=".2"/></>}
  </svg>;
}

export default function Search({ tables, onSelect, placeholder = 'Find table or column', shortcut = true, autoFocus = false, onCancel, variant = '', actionLabel = 'Open', tableOnlyToggle = false }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(50);
  const [tablesOnly, setTablesOnly] = useState(false);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const activeRef = useRef(null);
  const listId = useId();
  const index = useMemo(() => createSearchIndex(tables), [tables]);
  const results = useMemo(() => {
    const matches = searchIndex(index, query);
    return tablesOnly ? matches.filter((result) => result.kind === 'table') : matches;
  }, [index, query, tablesOnly]);
  const hasColumns = tables.some((table) => table.columns?.length);
  const expanded = open && Boolean(normalizeLabel(query).text);
  const visible = results.slice(0, limit);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  useEffect(() => { setActive(0); setLimit(50); }, [query, tables, tablesOnly]);
  useEffect(() => {
    if (expanded) activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [active, expanded]);

  useEffect(() => {
    const outside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    const handleShortcut = (event) => {
      if (tableOnlyToggle && event.key.toLowerCase() === 'g' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.isComposing) {
        const target = event.target;
        event.preventDefault();
        setTablesOnly((current) => target === inputRef.current ? !current : true);
        inputRef.current?.focus();
        setOpen(true);
        return;
      }
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
      event.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    };
    document.addEventListener('pointerdown', outside);
    if (shortcut) window.addEventListener('keydown', handleShortcut);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', handleShortcut);
    };
  }, [shortcut, tableOnlyToggle]);

  const toggleTablesOnly = () => {
    setTablesOnly((current) => !current);
    inputRef.current?.focus();
    setOpen(true);
  };

  const choose = (result) => {
    setQuery(''); setOpen(false); setActive(0);
    inputRef.current?.focus();
    onSelect(result);
  };
  const onKeyDown = (event) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && onCancel) {
      event.preventDefault(); event.stopPropagation(); onCancel();
    } else if (event.key === 'Escape' && expanded) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    } else if (event.target === inputRef.current && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); setOpen(true);
      setActive((current) => !expanded ? (event.key === 'ArrowDown' ? 0 : Math.max(0, visible.length - 1))
        : Math.max(0, Math.min(visible.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))));
    } else if (event.target === inputRef.current && event.key === 'Enter' && expanded && visible[active]) {
      event.preventDefault(); choose(visible[active]);
    }
  };

  return <div className={`search-wrap ${variant ? `search-wrap--${variant}` : ''}`} ref={rootRef} onKeyDown={onKeyDown}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <svg className="icon" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
    <input ref={inputRef} value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); setLimit(50); }}
      onFocus={() => setOpen(true)} placeholder={placeholder} aria-label={placeholder}
      role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
      aria-activedescendant={expanded && visible[active] ? `${listId}-${active}` : undefined} autoComplete="off" spellCheck={false}/>
    {query ? <button className="search-clear" type="button" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus(); }}>×</button> : shortcut && <kbd aria-hidden="true">/</kbd>}
    {tableOnlyToggle && <button className={`search-mode-toggle ${tablesOnly ? 'is-active' : ''}`} type="button" aria-pressed={tablesOnly} aria-label="Toggle table-only search" title="Toggle table-only search (Ctrl+G / ⌘G)" onClick={toggleTablesOnly}>T</button>}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{expanded ? `${results.length} ${results.length === 1 ? 'result' : 'results'} in this scope${tablesOnly ? ' (tables only)' : ''}.${hasColumns ? '' : ' Column metadata is unavailable; only tables can be searched.'}` : ''}</span>
    {expanded && <div className="search-results">
      <div className="search-summary">{results.length ? `${results.length} results · showing ${visible.length}${tablesOnly ? ' · tables only' : ''}` : 'No matches in this scope'}</div>
      {!hasColumns && <p className="search-note">Column metadata is unavailable; only tables can be searched.</p>}
      <div className="search-options" id={listId} role="listbox" aria-label="Tables and columns">
        {visible.map((result, position) => <div key={result.id} id={`${listId}-${position}`} role="option" aria-selected={active === position}
          ref={active === position ? activeRef : null} className={`search-option ${active === position ? 'is-active' : ''}`}
          onPointerMove={() => setActive(position)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(result)}>
          <ResultIcon kind={result.kind}/>
          <div className="search-option__text">
            <strong title={result.labels.name}><Highlight text={result.labels.name} ranges={result.highlights.name}/></strong>
            <small>{result.kind === 'column' ? <>Column in <Highlight text={result.labels.parent} ranges={result.highlights.parent}/></> : 'Table'} · {result.table.data_model_name || 'Data model'}</small>
            {result.kind === 'table' && result.physical !== result.name && result.highlights.physical && <small>Physical: <Highlight text={result.labels.physical} ranges={result.highlights.physical}/></small>}
            {result.kind === 'column' && result.parentPhysical !== result.parent && result.highlights.parentPhysical && <small>Physical table: <Highlight text={result.labels.parentPhysical} ranges={result.highlights.parentPhysical}/></small>}
          </div>
        </div>)}
      </div>
      {results.length > limit && <button type="button" className="search-more" onClick={() => {
        setLimit((current) => current + 50); setActive(limit); inputRef.current?.focus();
      }}>Show more ({results.length - limit} remaining)</button>}
      <div className="search-help">↑ ↓ Navigate · Enter {actionLabel} · Esc {onCancel ? 'Cancel' : 'Dismiss'}{tableOnlyToggle ? ' · Ctrl+G / ⌘G Tables only' : ''}</div>
    </div>}
  </div>;
}
