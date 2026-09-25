import React from 'react';
import { useReactFlow } from '@xyflow/react';
import NoteEditor from './NoteEditor.jsx';
import { MAX_NOTE_TITLE_LENGTH } from './stickyNotes.js';

export default function StickyNote({ id, data }) {
  const { updateNodeData, setNodes } = useReactFlow();
  return <article className="sticky-note" aria-label="Sticky note">
    <header className="sticky-note__header" title="Drag to move note">
      <svg className="sticky-note__grip" width="12" height="18" viewBox="0 0 12 18" fill="currentColor" aria-hidden="true">
        {[5, 9, 13].map((y) => <g key={y}><circle cx="4" cy={y} r="1"/><circle cx="8" cy={y} r="1"/></g>)}
      </svg>
      <input className="sticky-note__title nodrag nopan" aria-label="Note title" placeholder="Untitled note"
        value={data.title ?? ''} maxLength={MAX_NOTE_TITLE_LENGTH} title={data.title || 'Note title'}
        onChange={(event) => updateNodeData(id, { title: event.target.value })}
        onKeyDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} />
      <button type="button" className="nodrag nopan" aria-label="Delete sticky note" title="Delete note"
        onClick={() => setNodes((nodes) => nodes.filter((node) => node.id !== id))}>×</button>
    </header>
    <NoteEditor value={data.text} autoFocus={data.autoFocus}
      onChange={(text) => updateNodeData(id, { text })} />
  </article>;
}
