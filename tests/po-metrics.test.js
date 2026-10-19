import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calcLineWeightKg,
  calcOrderWeightKg,
  poDetailHref,
  isEtdBeyondContainer,
  poDetailUrl,
  filterAnnotationsForOrder,
  pickOrderAnnotation,
} from '../lib/po-metrics.js';

test('calcLineWeightKg multiplies box KG by quantity like Stock Items', () => {
  assert.equal(calcLineWeightKg({ weight_kg: 2.5 }, 4), 10);
  assert.equal(calcLineWeightKg({ weight_kg: '1.25' }, '8'), 10);
});

test('calcLineWeightKg is null when the item has no KG and 0 for no qty', () => {
  assert.equal(calcLineWeightKg(null, 5), null);
  assert.equal(calcLineWeightKg({ weight_kg: null }, 5), null);
  assert.equal(calcLineWeightKg({ weight_kg: 3 }, 0), 0);
});

test('calcOrderWeightKg sums known line weights only', () => {
  const dims = { A: { weight_kg: 2 }, B: { weight_kg: null } };
  const lines = [
    { inventoryId: 'A', qty: 3 },
    { inventoryId: 'B', qty: 10 },
    { inventoryId: 'C', qty: 1 },
  ];
  assert.equal(calcOrderWeightKg(lines, (id) => dims[id]), 6);
  assert.equal(calcOrderWeightKg([{ inventoryId: 'B', qty: 1 }], (id) => dims[id]), null);
});

test('poDetailHref encodes the order number', () => {
  assert.equal(poDetailHref('PO001234'), '/purchase-orders/PO001234');
  assert.equal(poDetailHref(' EX MNLP/1 '), '/purchase-orders/EX%20MNLP%2F1');
  assert.equal(poDetailHref(''), '');
});

test('isEtdBeyondContainer counts ETD today or later, not past ETD', () => {
  assert.equal(isEtdBeyondContainer('2026-10-20', '2026-10-19'), true);
  assert.equal(isEtdBeyondContainer('2026-10-19', '2026-10-19'), true);
  assert.equal(isEtdBeyondContainer('2026-10-18', '2026-10-19'), false);
  assert.equal(isEtdBeyondContainer('', '2026-10-19'), false);
});

test('poDetailUrl prefixes the deploy base path', () => {
  assert.equal(poDetailUrl('PO1'), '/purchase-orders/PO1');
  assert.equal(poDetailUrl('PO1', '/kgs-purchase/'), '/kgs-purchase/purchase-orders/PO1');
  assert.equal(poDetailUrl(''), '');
});

test('filterAnnotationsForOrder returns only that PO entries', () => {
  const all = {
    PO1: { remarks: 'a' },
    'Normal-PO1': { origin: 'China' },
    PO10: { remarks: 'other' },
    'Normal-PO10': { remarks: 'other' },
    'X1-PO1': { remarks: 'not a type prefix' },
  };
  assert.deepEqual(Object.keys(filterAnnotationsForOrder(all, 'PO1')).sort(), ['Normal-PO1', 'PO1']);
  assert.deepEqual(filterAnnotationsForOrder(all, ''), {});
});

test('pickOrderAnnotation prefers the bare order number key', () => {
  assert.deepEqual(pickOrderAnnotation({ 'Normal-PO1': { a: 1 }, PO1: { b: 2 } }, 'PO1'), { b: 2 });
  assert.deepEqual(pickOrderAnnotation({ 'Normal-PO1': { a: 1 } }, 'PO1'), { a: 1 });
  assert.deepEqual(pickOrderAnnotation({ PO2: {} }, 'PO1'), {});
});
