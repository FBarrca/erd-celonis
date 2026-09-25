import assert from 'node:assert/strict';
import test from 'node:test';
import { blankDraft, createDraftStore, pqlReference, resultCsv, validateDraft } from './queryDrafts.js';

test('query drafts survive reopen and remain isolated by pool and model', () => {
  const data = new Map();
  const storage = () => ({ getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  const draft = { ...blankDraft(), columns: [{ name: 'ID', query: '"ORDERS"."ID"' }] };
  createDraftStore(storage).save('pool', 'model', draft);
  const reopened = createDraftStore(storage);
  assert.deepEqual(reopened.load('pool', 'model'), draft);
  assert.deepEqual(reopened.load('pool', 'other'), blankDraft());
  assert.deepEqual(reopened.load('other', 'model'), blankDraft());
  assert.ok([...data.values()].every(value => !value.includes('rows')));
});

test('corrupt storage resets drafts and denied storage keeps in-memory edits', () => {
  const corrupt = createDraftStore(() => ({ getItem: () => '{broken' }));
  assert.deepEqual(corrupt.load('p', 'm'), blankDraft());
  const blocked = createDraftStore(() => { throw new Error('Denied'); });
  const draft = { ...blankDraft(), filters: ['FILTER 1 = 1;'] };
  blocked.save('p', 'm', draft);
  assert.deepEqual(blocked.load('p', 'm'), draft);
  assert.deepEqual(blocked.load('p', 'missing'), blankDraft());
});

test('references use table aliases and escape quoted identifiers', () => {
  assert.equal(pqlReference({ table: { alias: 'Order"Lines', name: 'RAW' }, column: 'ID' }), '"Order""Lines"."ID"');
  assert.equal(pqlReference({ table: { name: 'ORDERS' } }), '"ORDERS"');
});

test('draft validation catches missing names, duplicate names, filters and limits', () => {
  assert.ok(validateDraft(blankDraft()));
  const draft = { ...blankDraft(), columns: [{ name: 'ID', query: '1' }] };
  assert.equal(validateDraft(draft), '');
  assert.ok(validateDraft({ ...draft, columns: [...draft.columns, { name: ' ID ', query: '2' }] }));
  assert.ok(validateDraft({ ...draft, filters: ['1 = 1'] }));
  assert.ok(validateDraft({ ...draft, filters: ['FILTER ;'] }));
  assert.ok(validateDraft({ ...draft, limit: 10001 }));
  assert.equal(validateDraft({ ...draft, filters: ['FILTER\n 1=1;'] }), '');
});

test('CSV escapes commas, quotes, newlines and formula-like text, retaining nulls', () => {
  const csv = resultCsv({ columns: [{ name: 'value' }, { name: 'number' }], rows: [['a,"b"\nc', null], ['=1+1', -3], ['@formula', 5]] });
  assert.equal(csv, '"value","number"\r\n"a,""b""\nc",\r\n"\'=1+1","-3"\r\n"\'@formula","5"');
});
