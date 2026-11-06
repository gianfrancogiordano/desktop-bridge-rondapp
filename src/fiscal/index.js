/**
 * Fiscal printers in the bridge (PROVIDENCIA_00093_ANALISIS_Y_PLAN.md §4.1, Fase 2B).
 * List COM ports, read the printer status/identity (read-only), emit invoices and run the X/Z reports.
 * One operation per port at a time: a serial port cannot be shared and HKA commands must not interleave.
 */
const { HkaProtocol, FiscalProtocolError } = require('./hka/protocol');
const { emitInvoice, emitCreditNote, FiscalEmitError } = require('./hka/invoice');
const { parseSV, parseS1, parseU0X, igtfModeOf, withZCounter, swapZ } = require('./hka/parsers');
const { findModel } = require('./hka/models');
const { PowerShellSerialTransport } = require('./serial-powershell');
const ports = require('./ports');
const { HkaSimulator } = require('./hka/simulator');

/**
 * Simulator mode (RONDAPP_FISCAL_SIMULATOR=1): the bridge offers "SIM1" (an HKA-80 without IGTF, flag 50 =
 * 00) and "SIM2" (in IGTF mode, flag 50 = 01: foreign-currency payments 20–24 charge 3 %, documents close
 * with 199) that behave like the printer in memory, so the whole flow (POS → extension → bridge → backend)
 * can be tested without a printer, on any OS. The simulated printers keep their counters while the bridge runs.
 */
const SIMULATOR = process.env.RONDAPP_FISCAL_SIMULATOR === '1';
const simulators = new Map();
function simulatorFor(port) {
  if (!simulators.has(port)) simulators.set(port, new HkaSimulator({ lastInvoice: 0, igtfMode: port === 'SIM2' }));
  const sim = simulators.get(port);
  // The protocol closes the transport after each operation: the simulated printer (and its counters) must survive it
  return { write: (bytes) => sim.write(bytes), read: (ms) => sim.read(ms), close: async () => {} };
}
const isSimPort = (port) => SIMULATOR && /^SIM\d+$/i.test(String(port));

function listSerialPorts() {
  if (SIMULATOR) {
    return Promise.resolve([
      { port: 'SIM1', name: 'Simulador HKA-80 (sin máquina)', vid: null, pid: null, likelyHka: true },
      { port: 'SIM2', name: 'Simulador HKA-80 en modo IGTF', vid: null, pid: null, likelyHka: true },
    ]);
  }
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
    // IGTF (v8.5): flag 50 = 01 → la máquina lo cobra en los medios 20–24 (null = la máquina no lo informa)
    igtf: { mode: igtfModeOf(info.s3), rate: info.s3.igtf?.rate ?? null },
    flags: { 21: info.s3.flags?.[21] ?? null, 50: info.s3.flags?.[50] ?? null, 63: info.s3.flags?.[63] ?? null },
    status: info.status,
    // Raw answers: the layouts are not confirmed for every model (spike with the real printer)
    raw: { sv: info.sv.fields, s1: info.s1.fields, s3: info.s3.fields, s3Flags: info.s3.flags, s5: info.s5Raw },
  };
}

/** The simulated printers print instantly: no wait after the reports */
const NO_SETTLE = { xSettleMs: 0, zSettleMs: 0 };

/** Opens the port (or the injected transport), runs `fn(protocol)` and always closes it. */
function onPort({ port, workDir, openTransport, protocolOpts }, fn) {
  return withPort(port, async () => {
    const t = openTransport ? await openTransport(port)
      : isSimPort(port) ? simulatorFor(String(port).toUpperCase())
      : await PowerShellSerialTransport.open(port, workDir);
    try {
      return await fn(new HkaProtocol(t, { ...(isSimPort(port) ? NO_SETTLE : {}), ...protocolOpts }));
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
  return onPort({ port, workDir, openTransport }, async (p) => {
    const info = await p.readInfo();
    // Which S1 counter is the Z one (the manuals disagree): the next Z of U0X tells
    let nextZ = null;
    try { nextZ = parseU0X(await p.query('U0X')).nextZ; } catch { nextZ = null; }
    return toStatusResult(port, { ...info, s1: withZCounter(info.s1, nextZ) });
  });
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

/**
 * Reporte X (lectura) o Z (cierre del día), or D (prints the printer's programming, nothing fiscal).
 * Z with an open document is refused by the printer.
 * Before printing, the report's data is read without printing (U0X / U0Z: counters, bases, tax and IGTF of
 * the day) and returned as `data`, so the POS can keep the Z. For a Z the counter of S1 confirms it: it went
 * up by one → `number` is that Z. `data` is null if the printer did not answer U0X/U0Z (the report still prints).
 */
function runFiscalReport({ port, kind, workDir, openTransport, protocolOpts }) {
  if (kind !== 'X' && kind !== 'Z' && kind !== 'D') return Promise.reject(new Error('Reporte inválido: use X, Z o D'));
  return onPort({ port, workDir, openTransport, protocolOpts }, async (p) => {
    const before = await p.waitReady();
    if (before.state === 'fiscal_document_open') throw new FiscalProtocolError('document_open', 'Hay un documento fiscal abierto: ciérralo o anúlalo antes del reporte');
    if (!before.ready) throw new FiscalProtocolError('not_ready', `La impresora fiscal no está lista: ${before.error.message}`);
    if (kind === 'D') {
      // "D" imprime la programación (tasas, cajero, nombres de los medios de pago, flags, firmware): no es fiscal.
      // Ningún status devuelve los nombres de los medios de pago, así que es la forma de verlos sin el técnico.
      if (await p.command('D') === 'nak') throw new FiscalProtocolError('rejected', 'La impresora rechazó imprimir la programación');
      return { kind, status: await p.waitReady(30000) };
    }
    let data = null;
    try {
      data = parseU0X(await p.query(kind === 'X' ? 'U0X' : 'U0Z'), kind === 'X' ? 'U0X' : 'U0Z');
    } catch {
      data = null;
    }
    const s1Before = withZCounter(parseS1(await p.query('S1')), data?.nextZ);
    const r = await p.command(kind === 'X' ? 'I0X' : 'I0Z');
    if (r === 'nak') throw new FiscalProtocolError('rejected', `La impresora rechazó el reporte ${kind}`);
    await new Promise((res) => setTimeout(res, kind === 'Z' ? p.opts.zSettleMs : p.opts.xSettleMs));
    const after = await p.waitReady(60000); // a Z report takes a while to print
    const s1Read = parseS1(await p.query('S1'));
    const s1After = s1Before.zSwapped ? swapZ(s1Read) : s1Read;
    const result = { kind, status: after, serial: s1After.serial || s1Before.serial, printerDateTime: s1After.printerDateTime, data };
    if (kind === 'X') return result;
    const prev = s1Before.zReports;
    const now = s1After.zReports;
    if (prev !== null && now !== null && now !== prev + 1) {
      throw new FiscalProtocolError('z_not_done', `El contador de reportes Z pasó de ${prev} a ${now}: revisa el papel`);
    }
    return { ...result, number: now ?? data?.nextZ ?? null, previous: prev };
  });
}

module.exports = { readFiscalStatus, emitFiscalInvoice, emitFiscalCreditNote, runFiscalReport, listSerialPorts, withPort, toStatusResult };
