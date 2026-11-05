const test = require('node:test');
const assert = require('node:assert/strict');
const { parseS1, parseS3, parseSV, parseU0X, igtfModeOf } = require('../../src/fiscal/hka/parsers');
const { findModel, SAFE_DEFAULT } = require('../../src/fiscal/hka/models');

const LF = '\n';

test('S1: contadores, RIF, serial y fecha/hora de la máquina', () => {
  const s1 = parseS1(['S101', '00000000000150000', '00000041', '00003', '00000000', '00000', '00000002', '00000', '00000010', '00000', '0000', '0012', 'J123456789', 'Z1F1234567', '153000', '041126'].join(LF));
  assert.equal(s1.cashier, '01');
  assert.equal(s1.dailySales, 1500);
  assert.equal(s1.lastInvoice, 41);
  assert.equal(s1.lastCreditNote, 2);
  assert.equal(s1.zReports, 12);
  assert.equal(s1.rif, 'J123456789');
  assert.equal(s1.serial, 'Z1F1234567');
  assert.equal(s1.printerDateTime, '2026-11-04T15:30:00');
});

test('S1 incompleto: no explota, deja null y conserva los campos crudos', () => {
  const s1 = parseS1('S101' + LF + 'xx');
  assert.equal(s1.lastInvoice, null);
  assert.equal(s1.printerDateTime, null);
  assert.deepEqual(s1.fields, ['01', 'xx']);
});

test('S3: tres tasas (tipo + 4 dígitos) y flags', () => {
  const s3 = parseS3(['S321600', '20800', '23100', '0000000000'].join(LF));
  assert.deepEqual(s3.taxes.map(t => [t.slot, t.type, t.rate]), [[1, '2', 16], [2, '2', 8], [3, '2', 31]]);
  assert.deepEqual(s3.flags, { 0: '00', 1: '00', 2: '00', 3: '00', 4: '00' });
  assert.equal(s3.igtf.rate, null);
  assert.equal(parseS3('S3basura').taxes[0].rate, null);
});

test('SV y modelo: tolera guiones y espacios; desconocido → límites más restrictivos', () => {
  const sv = parseSV(['SVHKA80', 'VE'].join(LF));
  assert.equal(sv.model, 'HKA80');
  assert.equal(findModel(sv.model).id, 'HKA-80');
  assert.equal(findModel('srp 270').description, 26);
  assert.equal(findModel('MARCA-X'), SAFE_DEFAULT);
  assert.equal(findModel(''), SAFE_DEFAULT);
});

test('S2: totales del documento abierto (11 enteros + 2 decimales, en Bs)', () => {
  const { parseS2 } = require('../../src/fiscal/hka/parsers');
  const LF = String.fromCharCode(10);
  const text = ['S2 0000000089741', ' 0000000014359', ' 0000000000000', '000002', ' 0000000104100', '0000', '1'].join(LF);
  assert.deepEqual(
    (({ fields, ...r }) => r)(parseS2(text)),
    { base: 897.41, tax: 143.59, items: 2, toPay: 1041, payments: 0, docType: 1 },
  );
  const r21 = parseS2(['S21 0000000089741', ' 0000000014359'].join(LF), 'S21');
  assert.equal(r21.base, 897.41);
  assert.equal(r21.tax, 143.59);
});

test('S3 v8.5 (HKA-80, ancho fijo): tasas, IGTF 3 % y flags 50 y 63', () => {
  const flags = Array.from({ length: 64 }, (_, n) => (n === 50 ? '01' : n === 63 ? '17' : '00')).join('');
  const s3 = parseS3('S3' + '21600' + '20800' + '23100' + '20300' + flags);
  assert.deepEqual(s3.taxes.map(t => t.rate), [16, 8, 31]);
  assert.equal(s3.igtf.rate, 3);
  assert.equal(s3.flags[50], '01');
  assert.equal(s3.flags[63], '17');
  assert.equal(igtfModeOf(s3), true);
  assert.equal(igtfModeOf(parseS3('S3' + '21600' + '20800' + '23100' + '20300' + '00'.repeat(64))), false);
  assert.equal(igtfModeOf(parseS3(['S321600', '20800', '23100'].join(String.fromCharCode(10)))), null);
});

test('U0X v8.5: IGTF acumulado de facturas, NC y ND (posiciones 434/506, 524/542, 560/578)', () => {
  const amt = (v) => String(Math.round(v * 100)).padStart(18, '0');
  const head = '0013' + '041126' + '1530' + '00000042' + '041126' + '1529' + '00000003' + '00000000' + '00000010';
  const amounts = Array.from({ length: 30 }, () => 0);
  amounts[21] = 100; amounts[25] = 3; amounts[26] = 50; amounts[27] = 1.5;
  const text = 'U0X' + head + amounts.map(amt).join('');
  const u = parseU0X(text);
  assert.equal(head.length, 56);
  assert.equal(u.lastInvoice, 42);
  assert.equal(u.lastCreditNote, 3);
  assert.deepEqual(u.igtf, { invoices: { base: 100, igtf: 3 }, creditNotes: { base: 50, igtf: 1.5 }, debitNotes: { base: 0, igtf: 0 } });
  // Sin tramas ampliadas (flag 63): no hay IGTF
  assert.equal(parseU0X('U0X' + head + amounts.slice(0, 21).map(amt).join('')).igtf, null);
});
