const test = require('node:test');
const assert = require('node:assert/strict');
const { HkaProtocol } = require('../../src/fiscal/hka/protocol');
const { HkaSimulator } = require('../../src/fiscal/hka/simulator');
const { emitCreditNote, emitInvoice } = require('../../src/fiscal/hka/invoice');
const { buildCreditNoteCommands } = require('../../src/fiscal/hka/document');
const { emitFiscalCreditNote } = require('../../src/fiscal');
const { findModel } = require('../../src/fiscal/hka/models');

const FAST = { ackTimeoutMs: 40, frameTimeoutMs: 60, readyTimeoutMs: 400, pollMs: 5 };
const HKA80 = findModel('HKA80');
const TAXES = [{ slot: 1, rate: 16 }, { slot: 2, rate: 8 }, { slot: 3, rate: 31 }];
const NC = {
  client: { rif: 'V-12345678', name: 'José Pérez' },
  reference: { number: 42, date: '2026-11-04T15:30:00', serial: 'Z1F1234567' },
  comment: 'Cliente devolvió el pedido',
  items: [{ description: 'Hamburguesa', quantity: 2, unitPrice: 520.5, taxRate: 16 }, { description: 'Agua', quantity: 1, unitPrice: 100, taxRate: null }],
  payments: [{ code: '01', amount: 1141 }],
};
const run = (sim, doc = NC, variant) => emitCreditNote(new HkaProtocol(sim, FAST), doc, HKA80, variant);

test('comandos oficiales: cliente, factura afectada (nº, fecha, serial), comentario, ítems devueltos y pago', () => {
  assert.deepEqual(buildCreditNoteCommands(NC, HKA80, TAXES), [
    'iR*V-12345678', 'iS*José Pérez',
    'iF*00000000042', 'iD*04/11/2026', 'iI*Z1F1234567',
    'ACliente devolvió el pedido',
    'd1000005205000002000Hamburguesa', 'd0000001000000001000Agua',
    '101',
  ]);
});

test('variante sin "*" (firmware nuevo): nº de 8 dígitos y fecha ddMMyy', () => {
  const cmds = buildCreditNoteCommands(NC, HKA80, TAXES, 'colon');
  assert.deepEqual(cmds.slice(2, 5), ['iF:00000042', 'iD:041126', 'iI:Z1F1234567']);
});

test('sin cliente o sin referencia a la factura no se arma (son obligatorios)', () => {
  assert.throws(() => buildCreditNoteCommands({ ...NC, client: { name: 'X' } }, HKA80, TAXES), (e) => e.code === 'no_client');
  assert.throws(() => buildCreditNoteCommands({ ...NC, reference: { ...NC.reference, number: 0 } }, HKA80, TAXES), (e) => e.code === 'no_reference');
  assert.throws(() => buildCreditNoteCommands({ ...NC, reference: { ...NC.reference, date: '' } }, HKA80, TAXES), (e) => e.code === 'no_reference');
});

test('nota de crédito: la numera su propio contador y no toca el de facturas', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, lastCreditNote: 6 });
  const r = await run(sim);
  assert.equal(r.number, 7);
  assert.equal(r.previous, 6);
  assert.equal(r.variant, 'official');
  assert.equal(sim.lastInvoice, 41);
  assert.equal(sim.printed[0].kind, 'credit_note');
});

test('firmware que solo acepta la variante sin "*": reintenta con ella sin imprimir nada de más', async () => {
  const sim = new HkaSimulator({ lastCreditNote: 6, creditNoteVariant: 'colon' });
  const r = await run(sim);
  assert.equal(r.number, 7);
  assert.equal(r.variant, 'colon');
  assert.equal(sim.printed.length, 1); // nada anulado
});

test('si ya se sabe la variante de la máquina, se usa directo', async () => {
  const sim = new HkaSimulator({ lastCreditNote: 6, creditNoteVariant: 'colon' });
  await run(sim, NC, 'colon');
  assert.ok(!sim.received.some((c) => c.startsWith('iF*')));
});

test('rechazo de un ítem: no salió y no se reintenta con la otra variante (el problema no es la referencia)', async () => {
  const sim = new HkaSimulator({ lastCreditNote: 6, nakMatch: /^d1/ });
  await assert.rejects(run(sim), (e) => e.code === 'rejected' && e.emitted === false);
  assert.equal(sim.lastCreditNote, 6);
  assert.equal(sim.received.filter((c) => c.startsWith('iF')).length, 1);
});

test('se cortó después del cierre (ACK perdido): el contador de NC confirma que salió', async () => {
  const sim = new HkaSimulator({ lastCreditNote: 6, cutAfter: /^101$/ });
  const r = await run(sim);
  assert.equal(r.number, 7);
  assert.equal(r.recovered, true);
});

test('una factura después de una NC sigue con su número', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, lastCreditNote: 6 });
  await run(sim);
  const inv = await emitInvoice(new HkaProtocol(sim, FAST), { ...NC, reference: undefined }, HKA80);
  assert.equal(inv.number, 42);
});

test('mensaje del bridge (puerto simulado inyectado)', async () => {
  const sim = new HkaSimulator({ lastCreditNote: 0 });
  const r = await emitFiscalCreditNote({ port: 'COM9', document: NC, openTransport: async () => ({ write: (b) => sim.write(b), read: (ms) => sim.read(ms), close: async () => {} }) });
  assert.equal(r.number, 1);
  assert.equal(r.model, 'HKA-80');
});
