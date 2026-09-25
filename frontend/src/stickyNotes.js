export const NOTE_WIDTH = 260;
export const NOTE_HEIGHT = 220;
export const MAX_NOTE_LENGTH = 10000;
export const MAX_NOTE_TITLE_LENGTH = 120;

export function validateNotes(notes) {
  if (!Array.isArray(notes)) return [];
  const seen = new Set();
  return notes.flatMap((note) => {
    if (!note || typeof note.id !== 'string' || !note.id.startsWith('note:')
      || note.id.length > 128 || seen.has(note.id) || typeof note.text !== 'string'
      || !Number.isFinite(note.position?.x) || !Number.isFinite(note.position?.y)) return [];
    seen.add(note.id);
    const title = typeof note.title === 'string' ? note.title.replace(/[\r\n]/g, ' ').slice(0, MAX_NOTE_TITLE_LENGTH) : '';
    return [{ id: note.id, title, text: note.text.slice(0, MAX_NOTE_LENGTH), position: { x: note.position.x, y: note.position.y } }];
  });
}

export function noteNode(note, autoFocus = false) {
  return {
    id: note.id,
    type: 'stickyNote',
    position: { ...note.position },
    dragHandle: '.sticky-note__header',
    deletable: false,
    zIndex: 5,
    width: NOTE_WIDTH,
    height: NOTE_HEIGHT,
    ariaLabel: 'Sticky note',
    data: { title: note.title ?? '', text: note.text, autoFocus },
  };
}
