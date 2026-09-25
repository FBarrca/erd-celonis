import { MAX_EXPRESSION_LENGTH, tokenizePql } from './pqlLanguage.js';
import { pqlReference, validateDraft } from './queryDrafts.js';

export const MAX_SCRIPT_LENGTH = 65536;
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const unquote = value => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
const keyword = (token, word) => token?.type === 'keyword' && token.text.toUpperCase() === word;

export function scriptFromDraft(draft) {
  if (typeof draft.script === 'string') return draft.script;
  const expressions = draft.columns.filter(c => c.query.trim()).map((c, i) => `  ${c.query} AS ${quote(c.name || `Column ${i + 1}`)}`);
  return `${draft.filters.length ? `${draft.filters.join('\n')}\n\n` : ''}TABLE(${draft.distinct ? 'DISTINCT' : ''}\n${expressions.length ? expressions.join(',\n') : '  -- Add PQL expressions here'}\n);`;
}

export function exampleScript(table) {
  return `TABLE(\n  COUNT_TABLE(${pqlReference({ table })}) AS "Row count"\n);`;
}

// Parse only the query envelope, leaving PQL expressions to Celonis. Using
// tokens and delimiter depth avoids splitting function arguments or strings.
export function parsePqlScript(script, rowLimit = 1000) {
  const fail = (message, position = 0) => { throw new Error(`Line ${script.slice(0, position).split('\n').length}: ${message}`); };
  if (script.length > MAX_SCRIPT_LENGTH) fail(`Queries are limited to ${MAX_SCRIPT_LENGTH.toLocaleString()} characters.`);
  const raw = tokenizePql(script);
  if (raw.some(token => !token.closed)) fail('Close the quoted identifier, string, or comment.', raw.find(token => !token.closed).from);
  const tokens = raw.filter(token => token.type && token.type !== 'comment');
  const stack = [];
  for (const token of tokens) {
    token.depth = stack.length;
    if (token.type !== 'punctuation') continue;
    if ('([{'.includes(token.text)) stack.push(token);
    if (')]}'.includes(token.text)) {
      const opening = stack.pop();
      if (!opening || '([{'.indexOf(opening.text) !== ')]}'.indexOf(token.text)) fail('Mismatched brackets.', token.from);
      token.depth = stack.length;
    }
  }
  if (stack.length) fail('Close the bracket.', stack.at(-1).from);
  const result = { columns: [], filters: [], limit: rowLimit, distinct: false, limitFromScript: false };
  let i = 0, hasTable = false;
  const expression = parts => parts.length ? script.slice(parts[0].from, parts.at(-1).to).trim() : '';
  const addColumn = parts => {
    if (!parts.length) fail('Add an expression between commas.');
    const aliasAt = parts.findLastIndex(token => token.depth === 1 && keyword(token, 'AS'));
    let query = expression(parts), name;
    if (aliasAt >= 0) {
      const alias = parts.slice(aliasAt + 1);
      if (alias.length !== 1 || alias[0].type !== 'variableName') fail('Use AS "Result column name" after each expression.', parts[aliasAt].from);
      name = unquote(alias[0].text);
      query = expression(parts.slice(0, aliasAt));
    } else {
      const simpleReference = parts.length === 3 && parts[1].text === '.' && parts[2].type === 'variableName';
      name = simpleReference ? unquote(parts[2].text) : `Column ${result.columns.length + 1}`;
    }
    if (query.length > MAX_EXPRESSION_LENGTH) fail('Each expression is limited to 8,192 characters.', parts[0].from);
    if (name.length > 200) fail('Column names are limited to 200 characters.', parts[0].from);
    result.columns.push({ name, query });
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.text === ';') { i++; continue; }
    if (keyword(token, 'FILTER')) {
      const start = i++;
      while (i < tokens.length && !(tokens[i].depth === 0 && tokens[i].text === ';')) i++;
      if (i === tokens.length) fail('End each FILTER statement with a semicolon.', token.from);
      const filter = expression(tokens.slice(start, ++i));
      if (filter.length > MAX_EXPRESSION_LENGTH) fail('Each filter is limited to 8,192 characters.', token.from);
      result.filters.push(filter);
    } else if (keyword(token, 'TABLE')) {
      if (hasTable) fail('Run one TABLE query at a time.', token.from);
      hasTable = true;
      if (tokens[++i]?.text !== '(') fail('Write TABLE(expression AS "Name", ...).', token.from);
      i++;
      if (keyword(tokens[i], 'DISTINCT')) { result.distinct = true; i++; }
      let start = i;
      while (i < tokens.length && !(tokens[i].depth === 0 && tokens[i].text === ')')) {
        if (tokens[i].depth === 1 && tokens[i].text === ',') { addColumn(tokens.slice(start, i)); start = i + 1; }
        i++;
      }
      if (start === i) fail('Add at least one expression to TABLE, without a trailing comma.', tokens[i]?.from ?? token.from);
      addColumn(tokens.slice(start, i));
      i++;
    } else if (keyword(token, 'LIMIT')) {
      if (result.limitFromScript || !hasTable) fail('Use a single LIMIT after TABLE.', token.from);
      const limit = tokens[++i];
      if (!limit || !/^\d+$/.test(limit.text)) fail('LIMIT requires an integer between 1 and 10,000.', token.from);
      result.limit = Number(limit.text); result.limitFromScript = true; i++;
    } else fail('Use TABLE(...) and FILTER ...; statements. Set row limits with LIMIT or the toolbar.', token.from);
  }
  if (!hasTable) fail('Add a TABLE(...) query.');
  if (result.columns.length > 100 || result.filters.length > 20) fail('Use at most 100 expressions and 20 filters.');
  const problem = validateDraft(result);
  if (problem) fail(problem);
  return result;
}
