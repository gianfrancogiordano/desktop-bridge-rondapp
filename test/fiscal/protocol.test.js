const test = require('node:test');
const assert = require('node:assert/strict');
const { HkaProtocol } = require('../../src/fiscal/hka/protocol');
const { HkaSimulator } = require('../../src/fiscal/hka/simulator');

const FAST = { ackTimeoutMs: 60, frameTimeoutMs: 80, readyTimeoutMs: 300, pollMs: 5 };

test('readInfo: estado, modelo, serial, RIF, última factura y tasas', async () => {
  const sim = new HkaSimulator({ lastInvoice: 41 });
  const info = await new HkaProtocol(sim, FAST).readInfo();
  assert.equal(info.status.ready, true);
  assert.equal(info.model.id, 'HKA-80');
  assert.equal(info.s1.serial, 'Z1F1234567');
  assert.equal(info.s1.rif, 'J123456789');
  assert.equal(info.s1.lastInvoice, 41);
  assert.deepEqual(info.s3.taxes.map(t => t.rate), [16, 8, 31]);
  assert.deepEqual(sim.received, ['SV', 'S1', 'S3', 'S5']); // solo consultas: nada fiscal
});

test('respuesta en varios bloques (ETB + ACK + ETX) se une completa', async () => {
  const sim = new HkaSimulator({ multiBlock: true });
  const info = await new HkaProtocol(sim, FAST).readInfo();
  assert.equal(info.s1.serial, 'Z1F1234567');
  assert.equal(info.s1.lastInvoice, 41);
});

test('comando: ACK, NAK y silencio = ocupada (sin reenviar)', async () => {
  const sim = new HkaSimulator({ nak: ['I0X'] });
  const p = new HkaProtocol(sim, FAST);
  assert.equal(await p.command('I0Z'), 'ack');
  assert.equal(await p.command('I0X'), 'nak');
  sim.busyFor = 1;
  assert.equal(await p.command('I0Z'), 'busy');
  assert.equal(sim.received.filter(c => c === 'I0Z').length, 2); // no se reenvió solo
});

test('waitReady: espera mientras está ocupada y devuelve el estado cuando contesta', async () => {
  const sim = new HkaSimulator();
  sim.busyFor = 3; // no contesta a los primeros 3 ENQ
  const st = await new HkaProtocol(sim, FAST).waitReady();
  assert.equal(st.ready, true);
});

test('waitReady: documento abierto o sin papel se informan de inmediato', async () => {
  const sim = new HkaSimulator({ paperOut: true });
  const st = await new HkaProtocol(sim, FAST).waitReady();
  assert.equal(st.ready, false);
  assert.equal(st.error.code, 'paper_out');

  const sim2 = new HkaSimulator();
  const p2 = new HkaProtocol(sim2, FAST);
  assert.equal(await p2.command('!000000010000001000Arroz'), 'ack');
  const open = await p2.enq();
  assert.equal(open.state, 'fiscal_document_open');
  assert.equal(await p2.command('7'), 'ack'); // anular deja la máquina libre y consume un número
  assert.equal((await p2.enq()).ready, true);
  assert.equal(sim2.lastInvoice, 42);
});

test('máquina desconectada: timeout claro, nunca se cuelga', async () => {
  const sim = new HkaSimulator({ silent: true });
  await assert.rejects(new HkaProtocol(sim, FAST).enq(), (e) => e.code === 'timeout');
  await assert.rejects(new HkaProtocol(sim, FAST).waitReady(), (e) => e.code === 'busy');
});
