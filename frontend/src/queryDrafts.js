export const blankDraft = () => ({ columns: [{ name: '', query: '' }], filters: [], limit: 1000, distinct: false });

export function createDraftStore(getStorage = () => window.localStorage) {
  const memory = new Map();
  const keyFor = (pool, model) => `erd-celonis:pql:v1:${JSON.stringify([pool || '', model])}`;
  return {
    load(pool, model) {
      const key = keyFor(pool, model);
      try {
        const record = memory.get(key) ?? JSON.parse(getStorage().getItem(key));
        const draft = record?.draft;
        if (record?.version === 1 && Array.isArray(draft?.columns) && draft.columns.length > 0 && draft.columns.length <= 100
          && draft.columns.every(c => typeof c?.name === 'string' && typeof c?.query === 'string')
          && Array.isArray(draft.filters) && draft.filters.length <= 20 && draft.filters.every(f => typeof f === 'string')
          && (draft.script === undefined || typeof draft.script === 'string')
          && Number.isInteger(draft.limit) && draft.limit >= 1 && draft.limit <= 10000 && typeof draft.distinct === 'boolean') return structuredClone(draft);
      } catch { /* Use a fresh draft if storage is unavailable or corrupt. */ }
      return blankDraft();
    },
    save(pool, model, draft) {
      const key = keyFor(pool, model);
      const value = { version: 1, draft: structuredClone(draft) };
      memory.set(key, value);
      try { getStorage().setItem(key, JSON.stringify(value)); } catch { /* Retain drafts while the page is open. */ }
    },
  };
}

export function pqlReference(result) {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const table = quote(result.table.alias || result.table.name);
  return result.column ? `${table}.${quote(result.column)}` : table;
}

export function validateDraft(draft) {
  if (!draft.columns.length || draft.columns.some(c => !c.name.trim() || !c.query.trim())) return 'Give every expression a name and PQL expression.';
  if (new Set(draft.columns.map(c => c.name.trim())).size !== draft.columns.length) return 'Give each expression a unique column name.';
  if (draft.filters.some(f => !/^FILTER\s+\S[\s\S]*;$/i.test(f.trim()))) return 'Write each filter as FILTER condition; or remove the unused filter.';
  if (!Number.isInteger(draft.limit) || draft.limit < 1 || draft.limit > 10000) return 'Choose a row limit between 1 and 10,000.';
  return '';
}

export function resultCsv(result) {
  const cell = value => {
    if (value == null) return '';
    let text = String(value);
    // Prevent spreadsheet formula evaluation for text returned by a query.
    if (typeof value === 'string' && /^[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [result.columns.map(c => c.name), ...result.rows].map(row => row.map(cell).join(',')).join('\r\n');
}
