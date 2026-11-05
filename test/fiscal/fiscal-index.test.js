const test = require('node:test');
const assert = require('node:assert/strict');
const { readFiscalStatus, withPort } = require('../../src/fiscal');
const { toPorts, usbIds } = require('../../src/fiscal/ports');
const { HkaSimulator } = require('../../src/fiscal/hka/simulator');

test('readFiscalStatus con el simulador: datos para configurar la impresora en el POS', async () => {
  const sim = new HkaSimulator({ lastInvoice: 7 });
  let closed = false;
  sim.close = async () => { closed = true; };
  const r = await readFiscalStatus({ port: 'COM3', openTransport: async () => sim });
  assert.equal(r.port, 'COM3');
  assert.equal(r.model, 'HKA-80');
  assert.equal(r.modelKnown, true);
  assert.equal(r.modelLimits.paymentMethods, 24);
  assert.equal(r.serial, 'Z1F1234567');
  assert.equal(r.lastInvoice, 7);
  assert.equal(r.status.ready, true);
  assert.ok(Array.isArray(r.raw.s1));
  assert.equal(closed, true); // el puerto se libera siempre
});

test('readFiscalStatus informa el modo IGTF de la máquina (flag 50), su tasa y el flag 63', async () => {
  const on = await readFiscalStatus({ port: 'COM3', openTransport: async () => new HkaSimulator({ igtfMode: true }) });
  assert.deepEqual(on.igtf, { mode: true, rate: 3 });
  assert.deepEqual(on.flags, { 50: '01', 63: '17' });
  const off = await readFiscalStatus({ port: 'COM3', openTransport: async () => new HkaSimulator({ igtfMode: false }) });
  assert.equal(off.igtf.mode, false);
  // Firmware que no informa los flags (formato v8.3): no se sabe
  const old = await readFiscalStatus({ port: 'COM3', openTransport: async () => new HkaSimulator() });
  assert.deepEqual(old.igtf, { mode: null, rate: null });
});

test('el puerto se libera aunque la máquina no responda', async () => {
  const sim = new HkaSimulator({ silent: true });
  let closed = false;
  sim.close = async () => { closed = true; };
  await assert.rejects(readFiscalStatus({ port: 'COM4', openTransport: async () => sim }));
  assert.equal(closed, true);
});

test('dos operaciones sobre el mismo puerto no se mezclan (una detrás de otra)', async () => {
  const order = [];
  const slow = (name, ms) => withPort('COM5', async () => { order.push(name + ':start'); await new Promise(r => setTimeout(r, ms)); order.push(name + ':end'); });
  await Promise.all([slow('a', 20), slow('b', 1)]);
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
  // si una falla, la siguiente igual corre
  await assert.rejects(withPort('COM5', async () => { throw new Error('x'); }));
  assert.equal(await withPort('COM5', async () => 'ok'), 'ok');
});

test('puertos COM: la HKA (VID_04D8&PID_000A) primero', () => {
  assert.deepEqual(usbIds('USB\\VID_04d8&PID_000a\\5&2A'), { vid: '04D8', pid: '000A' });
  const ports = toPorts([
    { Name: 'Puerto de comunicaciones (COM1)', PNPDeviceID: 'ACPI\\PNP0501\\0' },
    { Name: 'USB Serial Device (COM10)', PNPDeviceID: 'USB\\VID_04D8&PID_000A\\5&2A' },
    { Name: 'Bluetooth', PNPDeviceID: 'BTH\\X' },
    { Name: 'Otro (COM3)', PNPDeviceID: 'USB\\VID_1A86&PID_7523\\1' },
  ]);
  assert.deepEqual(ports.map(p => [p.port, p.likelyHka]), [['COM10', true], ['COM1', false], ['COM3', false]]);
});

test('modo simulador: el puerto SIM1 numera seguido entre operaciones', async () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    const f = require('./src/fiscal');
    (async () => {
      const doc = { items: [{ description: 'Café', quantity: 1, unitPrice: 50, taxRate: 16 }], payments: [{ code: '01', amount: 50 }] };
      const a = await f.emitFiscalInvoice({ port: 'SIM1', document: doc });
      const b = await f.emitFiscalInvoice({ port: 'SIM1', document: doc });
      const st = await f.readFiscalStatus({ port: 'SIM1' });
      console.log(JSON.stringify([a.number, b.number, st.lastInvoice, (await f.listSerialPorts())[0].port]));
    })();
  `], { env: { ...process.env, RONDAPP_FISCAL_SIMULATOR: '1' }, cwd: require('node:path').join(__dirname, '../..') }).toString().trim();
  assert.deepEqual(JSON.parse(out), [1, 2, 2, 'SIM1']);
});
