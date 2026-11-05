const test = require('node:test');
const assert = require('node:assert/strict');
const { parseS1, parseS3, parseSV } = require('../../src/fiscal/hka/parsers');
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
  assert.deepEqual(s3.flags, ['0000000000']);
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
