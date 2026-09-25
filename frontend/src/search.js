import Fuse from 'fuse.js';

const fields = ['name', 'physical', 'parent', 'parentPhysical'];
const nameOf = (table) => table.alias || table.name || String(table.table_id || table.id);

// Keep original UTF-16 offsets: case folding can expand a character, and
// collapsing identifier separators changes the length of the indexed text.
export function normalizeLabel(value = '') {
  const original = String(value);
  let text = '';
  const offsets = [];
  let offset = 0;
  for (const character of original) {
    const end = offset + character.length - 1;
    if (/[\s_.-]/u.test(character)) {
      if (text && !text.endsWith(' ')) {
        text += ' ';
        offsets.push([offset, end]);
      } else if (text.endsWith(' ')) {
        offsets[offsets.length - 1][1] = end;
      }
    } else {
      const lower = character.toLowerCase();
      text += lower;
      for (let i = 0; i < lower.length; i += 1) offsets.push([offset, end]);
    }
    offset = end + 1;
  }
  if (text.endsWith(' ')) { text = text.slice(0, -1); offsets.pop(); }
  return { original, text, offsets };
}

export function createSearchIndex(tables) {
  const records = tables.flatMap((table) => {
    const makeRecord = (column) => {
      const kind = column ? 'column' : 'table';
      const labels = {
        name: column ? column.name : nameOf(table),
        physical: column ? '' : table.name || '',
        parent: column ? nameOf(table) : '',
        parentPhysical: column ? table.name || '' : '',
      };
      const mapped = Object.fromEntries(fields.map((key) => [key, normalizeLabel(labels[key])]));
      return {
        id: JSON.stringify([table.id, kind, column?.name]), kind, table, column: column?.name,
        labels, mapped, ...Object.fromEntries(fields.map((key) => [key, mapped[key].text])),
      };
    };
    return [makeRecord(), ...(table.columns || []).map(makeRecord)];
  });
  return new Fuse(records, {
    keys: [{ name: 'name', weight: 0.6 }, { name: 'physical', weight: 0.25 },
      { name: 'parent', weight: 0.1 }, { name: 'parentPhysical', weight: 0.05 }],
    threshold: 0.3, ignoreLocation: true, includeScore: true, includeMatches: true,
    useExtendedSearch: false,
  });
}

function mergeRanges(ranges) {
  const merged = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function highlightsFor(item, matches) {
  const highlights = {};
  for (const match of matches) {
    const offsets = item.mapped[match.key]?.offsets;
    if (!offsets) continue;
    const ranges = match.indices.flatMap(([start, end]) => offsets[start] && offsets[end]
      ? [[offsets[start][0], offsets[end][1]]] : []);
    highlights[match.key] = mergeRanges([...(highlights[match.key] || []), ...ranges]);
  }
  return highlights;
}

function relevance(item, query, words) {
  const names = item.kind === 'table' ? [item.name, item.physical] : [item.name];
  if (names.some((name) => name === query)) return 0;
  if (names.some((name) => name.startsWith(query))) return 1;
  if (names.some((name) => name.includes(query))) return 2;
  if (words.every((word) => fields.some((key) => item[key].includes(word)))) return 3;
  return 4;
}

export function searchIndex(index, query) {
  const normalized = normalizeLabel(query).text;
  if (!normalized) return [];
  const words = [...new Set(normalized.split(' '))];
  const expression = { $and: words.map((word) => ({ $or: fields.map((key) => ({ [key]: word })) })) };
  return index.search(expression).map(({ item, score, matches }) => ({
    ...item, score, rank: relevance(item, normalized, words), highlights: highlightsFor(item, matches || []),
  })).sort((a, b) => a.rank - b.rank || a.score - b.score
    || (a.kind === b.kind ? 0 : a.kind === 'table' ? -1 : 1)
    || a.name.localeCompare(b.name)
    || String(a.table.data_model_name || '').localeCompare(String(b.table.data_model_name || ''))
    || a.id.localeCompare(b.id));
}
