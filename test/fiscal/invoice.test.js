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
  assert.deepEqual(sim.printed.map(d => d.lines.at(-1)), ['ANULADA', '120']);
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
  const sim = new HkaSimulator({ lastInvoice: 41, cutAfter: /^120$/ });
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
  const r = await run(sim, { items: [{ description: 'Café', quantity: 2, unitPrice: 100, taxRate: 16 }], payments: [{ code: '01', amount: 300 }, { code: '13', amount: 10 }] });
  assert.equal(r.number, 42);
  assert.equal(r.recovered, true);
  assert.equal(sim.printed.length, 1);
  assert.notEqual(sim.printed[0].lines.at(-1), 'ANULADA');
});

test('lee los totales de la máquina (S2, S2E, S2n) antes del primer pago y los devuelve', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41 });
  const r = await run(sim);
  assert.equal(r.number, 42);
  // Precios con IVA incluido: 2 × 520,50 = 1041 → base 897,41 + IVA 143,59; el agua es exenta
  assert.deepEqual(r.totals, {
    base: 997.41, tax: 143.59, exempt: 100, toPay: 1141, items: 2,
    rates: [
      { slot: 1, rate: 16, base: 897.41, tax: 143.59 },
      { slot: 2, rate: 8, base: 0, tax: 0 },
      { slot: 3, rate: 31, base: 0, tax: 0 },
    ],
  });
  const firstPayment = sim.received.findIndex(c => /^[12]\d\d/.test(c));
  const s2 = sim.received.indexOf('S2');
  const lastItem = sim.received.findLastIndex(c => /^[ !"#]\d{10}/.test(c));
  assert.ok(lastItem < s2 && s2 < firstPayment, 'S2 va después de los ítems y antes de los pagos');
});

test('tasas programadas como excluidas: la máquina suma el IVA encima del precio', async () => {
  const sim = new HkaSimulator({ pricesIncludeTax: false });
  const r = await run(sim, { ...DOC, items: [{ description: 'Pizza', quantity: 1, unitPrice: 100, taxRate: 16 }], payments: [{ code: '01', amount: 116 }] });
  assert.equal(r.totals.base, 100);
  assert.equal(r.totals.tax, 16);
  assert.equal(r.totals.toPay, 116);
});

test('si la máquina no contesta S2 la factura sale igual, sin totales', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, noS2: true });
  const r = await run(sim);
  assert.equal(r.number, 42);
  assert.equal(r.totals, null);
  assert.equal(sim.printed.length, 1);
});

test('modo IGTF (flag 50 = 01): la máquina cobra el 3 % de las divisas, cierra con 199 y devuelve su IGTF (U0X)', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, igtfMode: true });
  const doc = { items: [{ description: 'Pizza', quantity: 1, unitPrice: 116, taxRate: 16 }], payments: [{ code: '20', amount: 103 }, { code: '01', amount: 16 }] };
  const r = await run(sim, doc);
  assert.equal(r.number, 42);
  // Bs primero (16), la divisa paga el resto (100) y la máquina suma 3 Bs de IGTF
  assert.deepEqual(sim.printed[0].lines.slice(-3), ['201000000001600', '120', '199']);
  assert.equal(sim.printed[0].igtf, 3);
  assert.deepEqual(r.totals.igtf, { base: 100, amount: 3 });
  // Segunda factura: el IGTF es solo el de esa (diferencia de U0X)
  const r2 = await run(sim, { ...doc, payments: [{ code: '20', amount: 119.48 }] });
  assert.deepEqual(r2.totals.igtf, { base: 116, amount: 3.48 });
});

test('máquina sin modo IGTF (flag 50 = 00) y un pago con código de divisas: no se manda nada', async () => {
  const sim = new HkaSimulator({ igtfMode: false });
  await assert.rejects(run(sim), (e) => e.code === 'igtf_off' && e.emitted === false);
  assert.ok(!sim.received.some(c => /^[!" #]\d{10}/.test(c)));
  assert.equal(sim.printed.length, 0);
});

test('sin modo IGTF no se lee U0X ni sale IGTF en los totales', async () => {
  const sim = new HkaSimulator({ igtfMode: false });
  const r = await run(sim, { ...DOC, payments: [{ code: '01', amount: 1141 }] });
  assert.equal(r.number, 42);
  assert.equal(r.totals.igtf, undefined);
  assert.ok(!sim.received.includes('U0X'));
  assert.ok(!sim.received.includes('199'));
});

test('cierre Z: lee sus datos (U0Z) antes de imprimir, devuelve su número y deja el día en cero', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41, zReports: 12, igtfMode: true });
  await run(sim, { items: [{ description: 'Pizza', quantity: 1, unitPrice: 116, taxRate: 16 }], payments: [{ code: '20', amount: 119.48 }] });
  await run(sim, { items: [{ description: 'Agua', quantity: 1, unitPrice: 10, taxRate: null }], payments: [{ code: '01', amount: 10 }] });
  const z = await runFiscalReport({ port: 'COM8', kind: 'Z', openTransport: async () => sim });
  assert.equal(z.kind, 'Z');
  assert.equal(z.number, 13);
  assert.equal(z.previous, 12);
  assert.equal(z.serial, 'Z1F1234567');
  assert.equal(z.data.nextZ, 13);
  assert.equal(z.data.lastInvoice, 43);
  assert.equal(z.data.sales.exempt, 10);
  assert.deepEqual(z.data.sales.rates[0], { slot: 1, base: 100, tax: 16 });
  assert.deepEqual(z.data.igtf.invoices, { base: 116, igtf: 3.48 });
  // Después del Z el día arranca en cero
  const x = await runFiscalReport({ port: 'COM8', kind: 'X', openTransport: async () => sim });
  assert.equal(x.data.sales.exempt, 0);
  assert.equal(x.data.igtf.invoices.igtf, 0);
});

test('cierre Z con un documento abierto: no se hace', async () => {
  const sim = new HkaSimulator();
  await new HkaProtocol(sim, FAST).command('!000000100000001000Abierto');
  await assert.rejects(runFiscalReport({ port: 'COM8', kind: 'Z', openTransport: async () => sim }), (e) => e.code === 'document_open');
});
