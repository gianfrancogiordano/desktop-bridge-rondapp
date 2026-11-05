/**
 * Emits one invoice (or credit note) on an HKA printer, safely. An invoice cannot be undone, so the rules are:
 *  1. Before: wait until the printer answers. A document left open (power cut, crash) is annulled with "7".
 *     Any other error (no paper…) stops here: nothing was sent.
 *  2. Read the last invoice number (S1) BEFORE sending anything.
 *  3. Send client, items and payments. A NAK annuls the document ("7") and reports `emitted: false`.
 *  4. Read S1 again: the number must have gone up by exactly 1 → that is the invoice number.
 *  5. If anything fails half-way, look at the printer before answering: number up by 1 → it DID print;
 *     document open → annul it, it did not; otherwise `emitted: 'unknown'` (a person must check the paper).
 * The caller must never retry an 'unknown' blindly. A credit note follows the same rules with its own
 * counter (S1 "última nota de crédito").
 */
const { parseS1, parseS3 } = require('./parsers');
const { buildInvoiceCommands, buildCreditNoteCommands, creditNoteHeaderLength, CREDIT_NOTE_VARIANTS } = require('./document');
const { FiscalProtocolError } = require('./protocol');

class FiscalEmitError extends Error {
  /** @param {boolean|'unknown'} emitted */
  constructor(code, message, emitted, extra = {}) {
    super(message);
    this.code = code;
    this.emitted = emitted;
    Object.assign(this, extra);
  }
}

/** What is being emitted: which S1 counter numbers it and how to name it in messages */
const KINDS = {
  invoice: { counter: 'lastInvoice', noun: 'la factura', Noun: 'La factura' },
  credit_note: { counter: 'lastCreditNote', noun: 'la nota de crédito', Noun: 'La nota de crédito' },
};

/** S1 with `last` = the counter of `kind` */
async function counterOf(p, kind) {
  const s1 = parseS1(await p.query('S1'));
  const last = s1[kind.counter];
  if (last === null || last === undefined) throw new FiscalEmitError('no_counter', `No se pudo leer el número de ${kind.noun} (S1)`, false);
  return { ...s1, last };
}

/** Annuls an open fiscal document; returns true if the printer accepted it. */
async function annulOpen(p) {
  const r = await p.command('7');
  if (r === 'busy') await p.waitReady();
  return r !== 'nak';
}

/**
 * @param {import('./protocol').HkaProtocol} p
 * @param {object} doc   see document.js
 * @param {object} model limits of the connected model (models.js)
 * @returns {Promise<{ number: number, serial: string, printerDateTime: string|null, previous: number, annulledOpenDocument: boolean }>}
 */
function emitInvoice(p, doc, model) {
  return emitDocument(p, KINDS.invoice, (taxes) => buildInvoiceCommands(doc, model, taxes));
}

/**
 * Credit note for an invoice. The reference lines have two known variants (document.js): the official one
 * is tried first; if the printer rejects a reference line before any document opened, the other is tried
 * once. Resolves with the `variant` that worked so the POS can remember it for this printer.
 * @param {'official'|'colon'} [variant] the one that worked last time
 */
async function emitCreditNote(p, doc, model, variant) {
  const first = CREDIT_NOTE_VARIANTS.includes(variant) ? variant : 'official';
  const order = [first, ...CREDIT_NOTE_VARIANTS.filter((v) => v !== first)];
  for (let i = 0; i < order.length; i++) {
    try {
      const r = await emitDocument(p, KINDS.credit_note, (taxes) => buildCreditNoteCommands(doc, model, taxes, order[i]));
      return { ...r, variant: order[i] };
    } catch (e) {
      const headerRejected = e instanceof FiscalEmitError && e.code === 'rejected' && e.emitted === false && !e.annulled && e.line < e.headerLength;
      if (!headerRejected || i === order.length - 1) throw e;
    }
  }
  throw new FiscalEmitError('rejected', 'La impresora rechazó la nota de crédito', false);
}

/**
 * @param {import('./protocol').HkaProtocol} p
 * @param {{ counter: string, noun: string, Noun: string }} kind
 * @param {(taxes: object[]) => string[]} build  the command lines, from the rates read with S3
 */
async function emitDocument(p, kind, build) {
  // 1. Printer state
  let st = await p.waitReady();
  let annulledOpenDocument = false;
  if (st.state === 'fiscal_document_open') {
    if (!(await annulOpen(p))) throw new FiscalEmitError('stuck_document', 'Hay un documento fiscal abierto que no se pudo anular', false);
    annulledOpenDocument = true;
    st = await p.waitReady();
  }
  if (!st.ready) throw new FiscalEmitError('not_ready', `La impresora fiscal no está lista: ${st.error.message}`, false, { status: st });

  // 2. Counters and rates (rates decide the tax char of each item)
  const before = await counterOf(p, kind);
  const s3 = parseS3(await p.query('S3'));
  let cmds;
  try {
    cmds = build(s3.taxes);
  } catch (e) {
    throw new FiscalEmitError(e.code || 'bad_document', e.message, false); // nothing was sent yet
  }

  // 3. Send
  for (let i = 0; i < cmds.length; i++) {
    let r;
    try {
      r = await p.command(cmds[i]);
    } catch (e) {
      return recover(p, kind, before, e); // the link failed: ask the printer what happened
    }
    if (r === 'ack') continue;
    if (r === 'busy') {
      // Silence: the line may or may not have been taken — e.g. the last payment DID close and print the
      // invoice but its ACK was lost. Never annul blindly: the counter decides.
      return recover(p, kind, before, new Error('la impresora dejó de responder'));
    }
    // NAK: the line was rejected. An open document is not trustworthy: annul it (uses a number, prints
    // "ANULADA"). If nothing is open, either nothing was printed yet (rejected client data) or an earlier
    // payment already closed the document: the counter tells which.
    const st = await p.waitReady().catch(() => null);
    const open = !!st && st.state === 'fiscal_document_open';
    if (st && !open) {
      const now = await counterOf(p, kind).catch(() => null);
      if (now && now.last === before.last + 1) {
        return { number: now.last, serial: now.serial || before.serial, printerDateTime: now.printerDateTime, previous: before.last, annulledOpenDocument, recovered: true };
      }
    }
    const annulled = open ? await annulOpen(p).catch(() => false) : false;
    throw new FiscalEmitError(
      'rejected',
      `La impresora fiscal rechazó la línea ${i + 1} (${cmds[i].slice(0, 24)}…)${annulled ? ' y se anuló el documento' : ''}`,
      st && (!open || annulled) ? false : 'unknown',
      { annulled, line: i, headerLength: creditNoteHeaderLength(cmds) },
    );
  }

  // 4. Confirm with the counter
  return confirm(p, kind, before, annulledOpenDocument);
}

async function confirm(p, kind, before, annulledOpenDocument) {
  const st = await p.waitReady();
  const after = await counterOf(p, kind);
  if (after.last === before.last + 1 && st.state === 'idle') {
    return { number: after.last, serial: after.serial || before.serial, printerDateTime: after.printerDateTime, previous: before.last, annulledOpenDocument };
  }
  if (st.state === 'fiscal_document_open') {
    const annulled = await annulOpen(p).catch(() => false);
    throw new FiscalEmitError('not_closed', `${kind.Noun} no se cerró (¿pagos incompletos?) y se anuló`, annulled ? false : 'unknown', { annulled });
  }
  throw new FiscalEmitError('counter_mismatch', `El contador de la impresora pasó de ${before.last} a ${after.last}: revisa el papel`, 'unknown');
}

/** Transport/protocol failure half-way: decide from the printer itself whether the invoice came out. */
async function recover(p, kind, before, cause) {
  try {
    const st = await p.waitReady();
    const after = await counterOf(p, kind);
    if (st.state === 'idle' && after.last === before.last + 1) {
      return { number: after.last, serial: after.serial || before.serial, printerDateTime: after.printerDateTime, previous: before.last, annulledOpenDocument: false, recovered: true };
    }
    if (st.state === 'fiscal_document_open') {
      const annulled = await annulOpen(p).catch(() => false);
      throw new FiscalEmitError('interrupted', `Se interrumpió ${kind.noun} (${cause.message}) y se anuló`, annulled ? false : 'unknown', { annulled });
    }
    if (after.last === before.last) {
      throw new FiscalEmitError('interrupted', `Se interrumpió ${kind.noun} antes de imprimirse (${cause.message})`, false);
    }
  } catch (e) {
    if (e instanceof FiscalEmitError) throw e;
  }
  throw new FiscalEmitError('interrupted', `Se interrumpió ${kind.noun} (${cause.message}): revisa si salió en papel`, 'unknown');
}

module.exports = { emitInvoice, emitCreditNote, FiscalEmitError, FiscalProtocolError };
