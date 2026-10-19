import test from 'node:test';
import assert from 'node:assert/strict';
import { calcPieceWeightKg, calcStockWeightKg } from '../lib/item-dimensions.js';

import {
  calcPoLineWeightKg,
  calcOrderWeightKg,
  poDetailHref,
  isEtdBeyondContainer,
  poDetailUrl,
  filterAnnotationsForOrder,
  pickOrderAnnotation,
  poLineKey,
  findPoLine,
  poLineHref,
  poLineUrl,
  isInteractiveClickTarget,
} from '../lib/po-metrics.js';

test('calcPoLineWeightKg uses piece weight (box KG / PCS/BOX) x qty for PO lines', () => {
  // Eyelet #2 130103101002100: box 33.5 kg, 25 pcs/box -> piece 1.34 kg; PO qty 30 -> 40.2 kg
  const eyelet = { weight_kg: 33.5, pcs_per_box: 25 };
  assert.ok(Math.abs(calcPoLineWeightKg(eyelet, 30) - 40.2) < 1e-9);
  // Stock Items keeps box KG x on-hand: 33.5 x 1,586 = 53,131 kg
  assert.ok(Math.abs(calcStockWeightKg({ weight_kg: 33.5, qty: 1586 }) - 53131) < 1e-9);
  assert.ok(Math.abs(calcPieceWeightKg(33.5, 25) - 1.34) < 1e-9);
  // No PCS/BOX: one unit is one box
  assert.equal(calcPoLineWeightKg({ weight_kg: 2.5 }, 4), 10);
  assert.equal(calcPoLineWeightKg({ weight_kg: '1.25' }, '8'), 10);
});

test('calcPoLineWeightKg is null when the item has no KG and 0 for no qty', () => {
  assert.equal(calcPoLineWeightKg(null, 5), null);
  assert.equal(calcPoLineWeightKg({ weight_kg: null }, 5), null);
  assert.equal(calcPoLineWeightKg({ weight_kg: 3 }, 0), 0);
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

test('poLineKey uses lineNbr and falls back to position', () => {
  assert.equal(poLineKey({ lineNbr: 3 }, 0), '3');
  assert.equal(poLineKey({ lineNbr: null }, 1), 'pos-2');
  assert.equal(poLineKey({}, 0), 'pos-1');
});

test('findPoLine tells apart the same item on two lines', () => {
  const lines = [
    { lineNbr: 1, inventoryId: 'A', qty: 5 },
    { lineNbr: 2, inventoryId: 'A', qty: 9 },
    { inventoryId: 'B', qty: 1 },
  ];
  assert.equal(findPoLine(lines, '2').line.qty, 9);
  assert.equal(findPoLine(lines, '1').line.qty, 5);
  assert.equal(findPoLine(lines, 'pos-3').line.inventoryId, 'B');
  assert.equal(findPoLine(lines, '7'), null);
  assert.equal(findPoLine(lines, ''), null);
});

test('poLineHref and poLineUrl build the line route', () => {
  assert.equal(poLineHref('PO1', '2'), '/purchase-orders/PO1/lines/2');
  assert.equal(poLineUrl('PO1', 'pos-1', '/kgs-purchase'), '/kgs-purchase/purchase-orders/PO1/lines/pos-1');
  assert.equal(poLineHref('', '2'), '');
});

test('isInteractiveClickTarget checks closest()', () => {
  assert.equal(isInteractiveClickTarget({ closest: () => ({}) }), true);
  assert.equal(isInteractiveClickTarget({ closest: () => null }), false);
  assert.equal(isInteractiveClickTarget(null), false);
});
