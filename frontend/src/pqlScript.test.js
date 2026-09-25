import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from './queryDrafts.js';
import { exampleScript, MAX_SCRIPT_LENGTH, parsePqlScript, scriptFromDraft } from './pqlScript.js';

test('script produces the existing API payload, preserving nested expressions and filters', () => {
  const script = `FILTER "Orders"."Value" > 10;
TABLE(DISTINCT
  "Orders"."ID" AS "Order ID",
  PU_SUM("Customers", "Orders"."Value", "Orders"."Value" > 20) AS "Total",
  CASE WHEN "Orders"."ID" IN (1, 2) THEN 'yes,;ok' ELSE 'no' END AS "Flag"
);
FILTER "Orders"."ID" != 0;
LIMIT 50;`;
  const result = parsePqlScript(script);
  assert.equal(result.columns.length, 3);
  assert.deepEqual(result.columns[0], { name: 'Order ID', query: '"Orders"."ID"' });
  assert.equal(result.columns[1].query, 'PU_SUM("Customers", "Orders"."Value", "Orders"."Value" > 20)');
  assert.match(result.columns[2].query, /'yes,;ok'/);
  assert.equal(result.filters.length, 2);
  assert.equal(result.distinct, true);
  assert.equal(result.limit, 50);
  assert.equal(result.limitFromScript, true);
});

test('aliases inside CAST are not column aliases; references get sensible default names', () => {
  const result = parsePqlScript('TABLE(CAST("T"."Value" AS INT) AS "Count", "T"."ID", SUM("T"."Value"))', 300);
  assert.deepEqual(result.columns.map(c => c.name), ['Count', 'ID', 'Column 3']);
  assert.equal(result.limit, 300);
  assert.equal(result.limitFromScript, false);
});

test('quoted punctuation, escaped quotes and comments do not split the envelope', () => {
  const result = parsePqlScript(`-- TABLE(ignored)
FILTER "T"."x" = 'it\\'s;,fine';
TABLE(/* comma , */ "T"."A,;" AS "Quote ""me""", 'x;,)') /* tail */;`);
  assert.equal(result.columns[0].name, 'Quote "me"');
  assert.equal(result.columns[1].query, "'x;,)'" );
  assert.equal(result.filters[0], `FILTER "T"."x" = 'it\\'s;,fine';`);
});

test('reports useful errors for malformed query envelopes and unsupported statements', () => {
  for (const [script, message] of [
    ['', /Add a TABLE/], ['TABLE()', /at least one/], ['TABLE(1,)', /trailing comma/],
    ['TABLE(1,,2)', /between commas/], ['TABLE(1', /Close the bracket/], ['TABLE([1))', /Mismatched/],
    ['TABLE(1 AS)', /Result column name/], ['TABLE(1 AS "")', /name and PQL/],
    ['TABLE(1 AS "A", 2 AS "A")', /unique/], ['TABLE(1); TABLE(2)', /one TABLE/],
    ['SELECT * FROM Orders', /Use TABLE/], ['FILTER x', /semicolon/], ['TABLE(1); FILTER ;', /condition/],
    ['TABLE(1); LIMIT 0', /row limit/], ['TABLE(1); LIMIT 10001', /row limit/],
    ['TABLE(1); LIMIT 1.5', /integer/], ['TABLE(1); LIMIT 1; LIMIT 2', /single LIMIT/],
    ['TABLE(\'unfinished)', /Close the quoted/], ['TABLE(1); /* unfinished', /comment/],
  ]) assert.throws(() => parsePqlScript(script), message, script);
  assert.throws(() => parsePqlScript('TABLE(1);\nBOGUS'), /Line 2:/);
});

test('preserves API bounds on columns, filters, expression sizes and script size', () => {
  assert.throws(() => parsePqlScript(`TABLE(${Array.from({ length: 101 }, (_, i) => `${i}`).join(',')})`), /100 expressions/);
  assert.throws(() => parsePqlScript(`${'FILTER x;\n'.repeat(21)}TABLE(1)`), /20 filters/);
  assert.throws(() => parsePqlScript(`TABLE('${'x'.repeat(8192)}')`), /8,192/);
  assert.throws(() => parsePqlScript(`TABLE(1 AS "${'x'.repeat(201)}")`), /200 characters/);
  assert.throws(() => parsePqlScript('x'.repeat(MAX_SCRIPT_LENGTH + 1)), /65,536/);
});

test('legacy drafts migrate without losing expressions, names, filters or distinct', () => {
  const legacy = { columns: [{ name: 'A "quote"', query: 'SUM("T"."X")' }], filters: ['FILTER "T"."X" > 0;'], limit: 250, distinct: true };
  const parsed = parsePqlScript(scriptFromDraft(legacy), legacy.limit);
  const { limitFromScript, ...roundTrip } = parsed;
  assert.deepEqual(roundTrip, legacy);
  assert.equal(scriptFromDraft({ ...legacy, script: 'unfinished edit' }), 'unfinished edit');
});

test('script drafts, including unfinished edits, persist independently per model', () => {
  const storage = new Map();
  const getStorage = () => ({ getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
  const store = createDraftStore(getStorage);
  store.save('pool', 'one', { ...store.load('pool', 'one'), script: 'TABLE(unfinished' });
  const reopened = createDraftStore(getStorage);
  assert.equal(reopened.load('pool', 'one').script, 'TABLE(unfinished');
  assert.equal(reopened.load('pool', 'two').script, undefined);
});

test('starter example uses the active table alias and is executable', () => {
  assert.deepEqual(parsePqlScript(exampleScript({ name: 'RAW', alias: 'Order "History"' })).columns,
    [{ name: 'Row count', query: 'COUNT_TABLE("Order ""History""")' }]);
});
