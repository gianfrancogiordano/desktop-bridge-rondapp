/**
 * Fiscal printers in the bridge (PROVIDENCIA_00093_ANALISIS_Y_PLAN.md §4.1, Fase 2B).
 * List COM ports, read the printer status/identity (read-only), emit invoices and run the X/Z reports.
 * One operation per port at a time: a serial port cannot be shared and HKA commands must not interleave.
 */
const { HkaProtocol, FiscalProtocolError } = require('./hka/protocol');
const { emitInvoice, emitCreditNote, FiscalEmitError } = require('./hka/invoice');
const { parseSV } = require('./hka/parsers');
const { findModel } = require('./hka/models');
const { PowerShellSerialTransport } = require('./serial-powershell');
const ports = require('./ports');
const { HkaSimulator } = require('./hka/simulator');

/**
 * Simulator mode (RONDAPP_FISCAL_SIMULATOR=1): the bridge offers a "SIM1" port that behaves like an HKA-80
 * in memory, so the whole flow (POS → extension → bridge → backend) can be tested without a printer,
 * on any OS. The simulated printer keeps its counters while the bridge runs.
 */
const SIMULATOR = process.env.RONDAPP_FISCAL_SIMULATOR === '1';
const simulators = new Map();
function simulatorFor(port) {
  if (!simulators.has(port)) simulators.set(port, new HkaSimulator({ lastInvoice: 0 }));
  const sim = simulators.get(port);
  // The protocol closes the transport after each operation: the simulated printer (and its counters) must survive it
  return { write: (bytes) => sim.write(bytes), read: (ms) => sim.read(ms), close: async () => {} };
}
const isSimPort = (port) => SIMULATOR && /^SIM\d+$/i.test(String(port));

function listSerialPorts() {
  if (SIMULATOR) return Promise.resolve([{ port: 'SIM1', name: 'Simulador HKA-80 (sin máquina)', vid: null, pid: null, likelyHka: true }]);
  return ports.listSerialPorts();
}

const locks = new Map();

/**
 * Runs `fn` with exclusive use of `port` (queued after any operation already running on it).
 * The queue tail never rejects: a failed operation must not leave an unhandled rejection nor block the next.
 */
function withPort(port, fn) {
  const key = String(port).toUpperCase();
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** Shape sent to the POS: what it needs to configure the printer and to check it before invoicing. */
function toStatusResult(port, info) {
  return {
    port,
    model: info.model.id,
    modelKnown: info.model.id !== 'unknown',
    modelLimits: info.model,
    reportedModel: info.sv.model,
    serial: info.s1.serial,
    rif: info.s1.rif,
    lastInvoice: info.s1.lastInvoice,
    lastCreditNote: info.s1.lastCreditNote,
    lastDebitNote: info.s1.lastDebitNote,
    zReports: info.s1.zReports,
    printerDateTime: info.s1.printerDateTime,
    taxes: info.s3.taxes,
    status: info.status,
    // Raw answers: the layouts are not confirmed for every model (spike with the real printer)
    raw: { sv: info.sv.fields, s1: info.s1.fields, s3: info.s3.fields, s3Flags: info.s3.flags, s5: info.s5Raw },
  };
}

/** Opens the port (or the injected transport), runs `fn(protocol)` and always closes it. */
function onPort({ port, workDir, openTransport }, fn) {
  return withPort(port, async () => {
    const t = openTransport ? await openTransport(port)
      : isSimPort(port) ? simulatorFor(String(port).toUpperCase())
      : await PowerShellSerialTransport.open(port, workDir);
    try {
      return await fn(new HkaProtocol(t));
    } finally {
      await t.close();
    }
  });
}

/**
 * Reads status + identity of the printer on `port`.
 * @param {{ port: string, workDir: string, openTransport?: (port: string) => Promise<import('./transport').Transport> }} args
 *        `openTransport` replaces the real COM port (tests use the simulator).
 */
function readFiscalStatus({ port, workDir, openTransport }) {
  return onPort({ port, workDir, openTransport }, async (p) => toStatusResult(port, await p.readInfo()));
}


/**
 * Prints one invoice. Resolves `{ number, serial, printerDateTime, previous, model }`; rejects with a
 * FiscalEmitError whose `emitted` is false (safe to retry), true or 'unknown' (a person must check the paper).
 */
function emitFiscalInvoice({ port, document, workDir, openTransport }) {
  return onPort({ port, workDir, openTransport }, async (p) => {
    const model = await modelOf(p);
    const r = await emitInvoice(p, document, model);
    return { ...r, model: model.id };
  });
}

/**
 * Prints a credit note for an invoice (document.reference = number, date and serial of the invoice).
 * Resolves like emitFiscalInvoice plus `variant` (the reference syntax this printer took).
 */
function emitFiscalCreditNote({ port, document, variant, workDir, openTransport }) {
  return onPort({ port, workDir, openTransport }, async (p) => {
    const model = await modelOf(p);
    const r = await emitCreditNote(p, document, model, variant);
    return { ...r, model: model.id };
  });
}

async function modelOf(p) {
  try {
    return findModel(parseSV(await p.query('SV')).model);
  } catch (e) {
    throw new FiscalEmitError(e.code || 'no_answer', `La impresora fiscal no responde: ${e.message}`, false);
  }
}

/** Reporte X (lectura) o Z (cierre del día). Z with an open document is refused by the printer. */
function runFiscalReport({ port, kind, workDir, openTransport }) {
  if (kind !== 'X' && kind !== 'Z') return Promise.reject(new Error('Reporte inválido: use X o Z'));
  return onPort({ port, workDir, openTransport }, async (p) => {
    const before = await p.waitReady();
    if (!before.ready) throw new FiscalProtocolError('not_ready', `La impresora fiscal no está lista: ${before.error.message}`);
    const r = await p.command(kind === 'X' ? 'I0X' : 'I0Z');
    if (r === 'nak') throw new FiscalProtocolError('rejected', `La impresora rechazó el reporte ${kind}`);
    const after = await p.waitReady(60000); // a Z report takes a while to print
    return { kind, status: after };
  });
}

module.exports = { readFiscalStatus, emitFiscalInvoice, emitFiscalCreditNote, runFiscalReport, listSerialPorts, withPort, toStatusResult };
