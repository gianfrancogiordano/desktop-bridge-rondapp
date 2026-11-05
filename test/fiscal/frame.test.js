const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFrame, parseFrame, lrc, encodeText, ETX, ETB, STX } = require('../../src/fiscal/hka/frame');
const { decodeStatus } = require('../../src/fiscal/hka/status');

test('trama del Reporte X igual al ejemplo del manual: 02 49 30 58 03 22', () => {
  assert.equal(buildFrame('I0X').toString('hex'), '024930580322');
});

test('estado rápido: STX STS1 STS2 ETX LRC', () => {
  // El ejemplo anotado del manual (02 62 41 03 21) no cuadra con la fórmula del LRC, que sí confirma el
  // ejemplo del Reporte X: con 62 41 el LRC es 0x20. Se valida con la máquina real (plan §9.1).
  const f = parseFrame(Buffer.from('0262410320', 'hex'));
  assert.equal(f.valid, true);
  assert.deepEqual([...f.data], [0x62, 0x41]);
  assert.equal(f.length, 5);
});

test('parseFrame: incompleta → null; ruido antes de STX; LRC malo; bloque ETB', () => {
  assert.equal(parseFrame(Buffer.from([STX, 0x41, ETX])), null); // falta el LRC
  const noisy = Buffer.concat([Buffer.from([0x06, 0x00]), buildFrame('S1')]);
  assert.equal(parseFrame(noisy).valid, true);
  assert.equal(parseFrame(noisy).length, noisy.length);
  const bad = buildFrame('S1'); bad[bad.length - 1] ^= 0xff;
  assert.equal(parseFrame(bad).valid, false);
  const data = encodeText('ABC');
  const etb = Buffer.concat([Buffer.from([STX]), data, Buffer.from([ETB, lrc(data, ETB)])]);
  assert.equal(parseFrame(etb).terminator, ETB);
  assert.equal(parseFrame(etb).valid, true);
});

test('texto en Latin-1: ñ y tildes pasan, emojis se vuelven "?"', () => {
  assert.deepEqual([...encodeText('Ñandú')], [0xd1, 0x61, 0x6e, 0x64, 0xfa]);
  assert.equal(encodeText('ok🙂').toString('latin1'), 'ok??');
});

test('decodeStatus: fiscal en espera listo; documento abierto; sin papel', () => {
  assert.equal(decodeStatus(0x60, 0x40).ready, true);
  const open = decodeStatus(0x61, 0x40);
  assert.equal(open.state, 'fiscal_document_open');
  assert.equal(open.ready, false);
  const paper = decodeStatus(0x60, 0x41);
  assert.equal(paper.error.code, 'paper_out');
  assert.equal(paper.ready, false);
  assert.equal(decodeStatus(0x6a, 0x40).memoryFull, true);
  assert.equal(decodeStatus(0x77, 0x99).mode, 'unknown');
});
