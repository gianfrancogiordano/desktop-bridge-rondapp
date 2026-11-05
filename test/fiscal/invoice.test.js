const test = require('node:test');
const assert = require('node:assert/strict');
const { HkaProtocol } = require('../../src/fiscal/hka/protocol');
const { HkaSimulator } = require('../../src/fiscal/hka/simulator');
const { emitInvoice } = require('../../src/fiscal/hka/invoice');
const { emitFiscalInvoice, runFiscalReport } = require('../../src/fiscal');
const { findModel } = require('../../src/fiscal/hka/models');

const FAST = { ackTimeoutMs: 40, frameTimeoutMs: 60, readyTimeoutMs: 400, pollMs: 5 };
const HKA80 = findModel('HKA80');
const DOC = {
  client: { rif: 'V-12345678', name: 'José Pérez' },
  items: [{ description: 'Hamburguesa', quantity: 2, unitPrice: 520.5, taxRate: 16 }, { description: 'Agua', quantity: 1, unitPrice: 100, taxRate: null }],
  payments: [{ code: '20', amount: 700 }, { code: '01', amount: 441 }],
};
const run = (sim, doc = DOC) => emitInvoice(new HkaProtocol(sim, FAST), doc, HKA80);

test('factura normal: el número es el siguiente de la máquina', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41 });
  const r = await run(sim);
  assert.equal(r.number, 42);
  assert.equal(r.previous, 41);
  assert.equal(r.serial, 'Z1F1234567');
  assert.equal(sim.printed.length, 1);
  assert.ok(sim.printed[0].lines.includes('!000005205000002000Hamburguesa'));
});

test('documento abierto de antes (corte de luz): se anula primero y luego se factura', async () => {
  const sim = new HkaSimulator({ lastInvoice: 10 });
  await new HkaProtocol(sim, FAST).command('!000000100000001000Viejo'); // quedó abierto
  const r = await run(sim);
  assert.equal(r.annulledOpenDocument, true);
  assert.equal(r.number, 12); // el 11 se usó en la anulación
  assert.deepEqual(sim.printed.map(d => d.lines.at(-1)), ['ANULADA', '101']);
});

test('sin papel: no se manda nada y es seguro reintentar', async () => {
  const sim = new HkaSimulator({ paperOut: true });
  await assert.rejects(run(sim), (e) => e.code === 'not_ready' && e.emitted === false);
  assert.ok(!sim.received.some(c => c.startsWith('!')));
});

test('tasa no programada: error claro antes de mandar nada', async () => {
  const sim = new HkaSimulator({ taxes: ['20800', '20800', '20800'] });
  await assert.rejects(run(sim), (e) => e.code === 'tax_not_programmed' && e.emitted === false);
  assert.equal(sim.printed.length, 0);
});

test('línea rechazada (NAK) con el documento abierto: se anula y no se emitió', async () => {
  const sim = new HkaSimulator({ lastInvoice: 5, nakMatch: /^ 0/ }); // rechaza el ítem exento
  await assert.rejects(run(sim), (e) => e.code === 'rejected' && e.emitted === false && e.annulled === true);
  assert.deepEqual(sim.printed.map(d => d.lines.at(-1)), ['ANULADA']);
});

test('datos del cliente rechazados (nada abierto todavía): no se emitió y no se anula nada', async () => {
  const sim = new HkaSimulator({ nakMatch: /^iR\*/ });
  await assert.rejects(run(sim), (e) => e.code === 'rejected' && e.emitted === false && e.annulled === false);
  assert.equal(sim.printed.length, 0);
});

test('se pierde el ACK del pago final pero la factura SÍ salió: se reconoce, nunca se anula', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, cutAfter: /^101$/ });
  const r = await run(sim);
  assert.equal(r.number, 42);
  assert.equal(r.recovered, true);
  assert.equal(sim.printed.length, 1);
  assert.notEqual(sim.printed[0].lines.at(-1), 'ANULADA');
});

test('se corta a mitad de los ítems: se anula lo abierto y no se emitió', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, cutBefore: /^ 0/ });
  await assert.rejects(run(sim), (e) => e.code === 'interrupted' && e.emitted === false && e.annulled === true);
  assert.deepEqual(sim.printed.map(d => d.lines.at(-1)), ['ANULADA']);
});

test('la máquina desaparece y no vuelve: "desconocido", hay que revisar el papel', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, cutAfter: /^ 0/, outageWrites: 100000 });
  await assert.rejects(run(sim), (e) => e.emitted === 'unknown');
});

test('emitFiscalInvoice por puerto: detecta el modelo y devuelve número y serial', async () => {
  const sim = new HkaSimulator({ lastInvoice: 99 });
  const r = await emitFiscalInvoice({ port: 'COM7', document: DOC, openTransport: async () => sim });
  assert.equal(r.number, 100);
  assert.equal(r.model, 'HKA-80');
});

test('reportes X y Z', async () => {
  const sim = new HkaSimulator();
  assert.equal((await runFiscalReport({ port: 'COM8', kind: 'Z', openTransport: async () => sim })).kind, 'Z');
  assert.ok(sim.received.includes('I0Z'));
  await assert.rejects(runFiscalReport({ port: 'COM8', kind: 'Y', openTransport: async () => sim }), /Reporte inválido/);
  const paper = new HkaSimulator({ paperOut: true });
  await assert.rejects(runFiscalReport({ port: 'COM9', kind: 'X', openTransport: async () => paper }), /no está lista/);
});

test('la máquina totaliza menos que nosotros: un parcial cierra la factura y el pago final da NAK → emitida', async () => {
  // Máquina con total distinto al calculado (redondeo/programación): el parcial recortado igual la cierra
  const sim = new HkaSimulator({ lastInvoice: 41, totalFactor: 0.5 });
  const r = await run(sim, { items: [{ description: 'Café', quantity: 2, unitPrice: 100, taxRate: 16 }], payments: [{ code: '20', amount: 300 }, { code: '01', amount: 10 }] });
  assert.equal(r.number, 42);
  assert.equal(r.recovered, true);
  assert.equal(sim.printed.length, 1);
  assert.notEqual(sim.printed[0].lines.at(-1), 'ANULADA');
});
