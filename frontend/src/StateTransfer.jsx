import React, { useRef, useState } from 'react';
import { MAX_STATE_BYTES, parseDatapoolState } from './datapoolState.js';

export default function StateTransfer({ onImport, onExport }) {
  const input = useRef(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const importFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    setBusy(true);
    try {
      if (file.size > MAX_STATE_BYTES) throw new Error('Choose a datapool export smaller than 25 MB.');
      const snapshot = parseDatapoolState(await file.text());
      onImport(snapshot);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const exportFile = () => {
    setError('');
    try {
      const snapshot = onExport();
      const json = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      if (blob.size > MAX_STATE_BYTES) throw new Error('This datapool exceeds the 25 MB export limit.');
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const name = snapshot.graph.metadata.data_pool_name || snapshot.graph.metadata.data_pool_id || 'datapool';
      link.href = url;
      link.download = `${name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 80)}.erd.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause.message); }
  };
  return <div className="state-transfer">
    <input ref={input} type="file" accept=".json,application/json" hidden aria-label="Datapool state file" onChange={importFile}/>
    <button type="button" disabled={busy} onClick={() => input.current?.click()} aria-label="Import datapool" title="Import datapool — open saved tables, layouts, and notes">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>
    </button>
    <button type="button" disabled={busy || !onExport} onClick={exportFile} aria-label="Export datapool" title="Export datapool — save all loaded models, layouts, and notes">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v13m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></svg>
    </button>
    {error && <div className="state-transfer__error" role="alert">{error}<button type="button" aria-label="Dismiss import or export error" onClick={() => setError('')}>×</button></div>}
  </div>;
}
