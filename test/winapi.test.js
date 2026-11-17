const test = require('node:test');
const assert = require('node:assert/strict');
const koffi = require('koffi');
const { printerStatus, hkaDcbFlags, types } = require('../src/winapi');

test('las estructuras miden lo mismo que en Windows x64', () => {
  const T = types();
  assert.equal(koffi.sizeof(T.DCB), 28);
  assert.equal(koffi.sizeof(T.COMMTIMEOUTS), 20);
  assert.equal(koffi.sizeof(T.GUID), 16);
  assert.equal(koffi.sizeof(T.SP_DEVINFO_DATA), 32);
  assert.equal(koffi.sizeof(T.PRINTER_INFO_2W), 136);
  assert.equal(koffi.sizeof(T.DOC_INFO_1W), 24);
});

test('DCB del HKA: binario, paridad, CTS, RTS handshake, sin DTR ni XON/XOFF', () => {
  // GetCommState típico: fBinary + fDtrControl ENABLE + fRtsControl ENABLE + fTXContinueOnXoff + fOutX + fAbortOnError
  const f = hkaDcbFlags((1 << 0) | (1 << 4) | (1 << 12) | (1 << 7) | (1 << 8) | (1 << 14));
  assert.equal(f & 1, 1); // fBinary
  assert.equal((f >> 1) & 1, 1); // fParity
  assert.equal((f >> 2) & 1, 1); // fOutxCtsFlow
  assert.equal((f >> 3) & 1, 0); // fOutxDsrFlow
  assert.equal((f >> 4) & 3, 0); // fDtrControl DISABLE
  assert.equal((f >> 7) & 1, 1); // fTXContinueOnXoff se respeta
  assert.equal((f >> 8) & 1, 0); // fOutX
  assert.equal((f >> 12) & 3, 2); // fRtsControl HANDSHAKE
  assert.equal((f >> 14) & 1, 0); // fAbortOnError
});

test('estado de la impresora con el mismo vocabulario que el camino PowerShell', () => {
  assert.equal(printerStatus(0, 0), 'idle');
  assert.equal(printerStatus(0, 0x400), 'offline'); // WORK_OFFLINE
  assert.equal(printerStatus(0x80, 0), 'offline');
  assert.equal(printerStatus(0x400, 0), 'printing');
  assert.equal(printerStatus(0x1, 0), 'stopped');
  assert.equal(printerStatus(0x2, 0), 'stopped');
  assert.equal(printerStatus(0x8000, 0), 'unknown');
});

test('koffi decodifica una estructura dentro de un Buffer con desplazamiento', () => {
  const T = types();
  const size = koffi.sizeof(T.COMMTIMEOUTS);
  const buf = Buffer.alloc(size * 2);
  buf.writeUInt32LE(0xFFFFFFFF, size); // segundo elemento, ReadIntervalTimeout
  buf.writeUInt32LE(3000, size + 16); // WriteTotalTimeoutConstant
  const t = koffi.decode(buf, size, T.COMMTIMEOUTS);
  assert.equal(t.ReadIntervalTimeout, 0xFFFFFFFF);
  assert.equal(t.WriteTotalTimeoutConstant, 3000);
});
