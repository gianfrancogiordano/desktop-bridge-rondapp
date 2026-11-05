const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInvoiceCommands, taxSlotFor, cleanText, formatPrice, formatQuantity, formatPayment } = require('../../src/fiscal/hka/document');
const { findModel } = require('../../src/fiscal/hka/models');

const HKA80 = findModel('HKA80');
const S3 = [{ slot: 1, rate: 16 }, { slot: 2, rate: 8 }, { slot: 3, rate: 31 }];

test('formatos: precio 8+2, cantidad 5+3, pago 10+2', () => {
  assert.equal(formatPrice(15), '0000001500');
  assert.equal(formatPrice(1234.567), '0000123457');
  assert.equal(formatQuantity(1), '00001000');
  assert.equal(formatQuantity(0.25), '00000250');
  assert.equal(formatPayment(100.5), '000000010050');
  assert.throws(() => formatPrice(100000000), /demasiado grande/);
  assert.throws(() => formatPrice(-1), /inválido/);
});

test('tasa → carácter según lo que la máquina tiene programado (S3), nunca asumido', () => {
  assert.equal(taxSlotFor(16, S3), 1);
  assert.equal(taxSlotFor(8, S3), 2);
  assert.equal(taxSlotFor(null, S3), 0);
  assert.equal(taxSlotFor(0, S3), 0);
  assert.equal(taxSlotFor(16, [{ slot: 1, rate: 8 }, { slot: 2, rate: 16 }]), 2);
  assert.throws(() => taxSlotFor(12, S3), /no tiene programada la tasa de 12%/);
});

test('texto limpio: sin "|" ni saltos, recortado al largo del modelo', () => {
  assert.equal(cleanText('Pizza | grande\n', 40), 'Pizza grande');
  assert.equal(cleanText('Hamburguesa especial doble con tocineta', findModel('SRP-270').description), 'Hamburguesa especial doble');
});

test('factura completa: cliente, ítems (exento y gravado) y pago mixto', () => {
  const cmds = buildInvoiceCommands({
    client: { rif: 'V-12345678', name: 'José Pérez' },
    extraLines: ['Orden R-014 · Mesa 5'],
    items: [
      { description: 'Hamburguesa', quantity: 2, unitPrice: 520.5, taxRate: 16 },
      { description: 'Agua', quantity: 1, unitPrice: 100, taxRate: null },
    ],
    payments: [{ code: '20', amount: 700 }, { code: '01', amount: 441 }],
  }, HKA80, S3); // total 1141
  assert.deepEqual(cmds, [
    'iR*V-12345678',
    'iS*José Pérez',
    'i00Orden R-014 · Mesa 5',
    '!000005205000002000Hamburguesa',
    ' 000001000000001000Agua',
    '220000000070000',
    '101',
  ]);
});

test('consumidor final sin datos: no manda iR/iS; 199 solo si se configuró', () => {
  const cmds = buildInvoiceCommands({ items: [{ description: 'Café', quantity: 1, unitPrice: 50, taxRate: 16 }], payments: [{ code: 1, amount: 58 }], finalize199: true }, HKA80, S3);
  assert.deepEqual(cmds, ['!000000500000001000Café', '101', '199']);
});

test('errores antes de mandar nada: sin ítems, sin pagos, código fuera de rango del modelo', () => {
  assert.throws(() => buildInvoiceCommands({ items: [], payments: [{ code: '01' }] }, HKA80, S3), /no tiene ítems/);
  assert.throws(() => buildInvoiceCommands({ items: [{ description: 'x', quantity: 1, unitPrice: 1 }], payments: [] }, HKA80, S3), /no tiene pagos/);
  const item = [{ description: 'x', quantity: 1, unitPrice: 1, taxRate: 16 }];
  assert.throws(() => buildInvoiceCommands({ items: item, payments: [{ code: '20' }] }, findModel('HKA-112'), S3), /inválido para esta impresora \(01–16\)/);
  assert.throws(() => buildInvoiceCommands({ items: [{ description: 'x', quantity: 0, unitPrice: 1 }], payments: [{ code: '01' }] }, HKA80, S3), /Cantidad inválida/);
});

test('pagos parciales que alcanzarían el total (propina, IGTF) se recortan: el último siempre cierra', () => {
  const base = { items: [{ description: 'Café', quantity: 2, unitPrice: 100, taxRate: 16 }] }; // total 200
  // 250 en divisas (incluye propina) + 10 Bs: el parcial se recorta a 199 y el último cierra
  assert.deepEqual(
    buildInvoiceCommands({ ...base, payments: [{ code: '20', amount: 250 }, { code: '01', amount: 10 }] }, HKA80, S3),
    ['!000001000000002000Café', '220000000019900', '101'],
  );
  // un parcial sin espacio se omite
  assert.deepEqual(
    buildInvoiceCommands({ ...base, payments: [{ code: '20', amount: 199.5 }, { code: '02', amount: 5 }, { code: '01', amount: 1 }] }, HKA80, S3),
    ['!000001000000002000Café', '220000000019900', '101'],
  );
});

test('total esperado con tasas excluidas suma el IVA', () => {
  const { expectedTotal } = require('../../src/fiscal/hka/document');
  const items = [{ unitPrice: 100, quantity: 2, taxRate: 16 }, { unitPrice: 50, quantity: 1, taxRate: null }];
  assert.equal(expectedTotal({ items }, S3), 250);
  assert.equal(expectedTotal({ items, pricesIncludeTax: false }, S3), 282);
});

