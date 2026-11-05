/**
 * Fiscal document → HKA command lines (manual v8.3 §9.2 of the plan). Pure functions: no I/O.
 *
 * Invoice order: client (iR* RIF, iS* name) → extra lines (iNN) → items → payments.
 * Item:    <tax char><price 10 = 8+2><quantity 8 = 5+3><description>      e.g. "!000000150000001000Harina"
 * Payment: "2NN" + amount 12 (10+2) for partial payments, "1NN" pays the rest and closes the document.
 * Amounts are in bolívares (the printer works in Bs): the POS converts with the BCV rate of the payment.
 */

const TAX_CHARS = [' ', '!', '"', '#']; // slot 0 = exento, 1–3 = tax rates programmed in the printer (S3)
const CREDIT_TAX_CHARS = ['d0', 'd1', 'd2', 'd3']; // returned item in a credit note, same slots

/**
 * Credit-note reference to the original invoice. The manual v8.3 documents "iF*", "iD*" (DD/MM/AAAA) and
 * "iI*"; third-party sources use "iF:", "iD:" (ddMMyy) and "iI:" on newer firmware (validar en el spike).
 */
const CREDIT_NOTE_VARIANTS = ['official', 'colon'];

class FiscalDocumentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** 12.5 → "0000001250" (cents, zero-padded). */
function digits(value, intDigits, decDigits) {
  const scaled = Math.round(Number(value) * 10 ** decDigits);
  if (!Number.isFinite(scaled) || scaled < 0) throw new FiscalDocumentError('bad_amount', `Monto inválido: ${value}`);
  const s = String(scaled);
  if (s.length > intDigits + decDigits) throw new FiscalDocumentError('amount_too_large', `Monto demasiado grande para la impresora fiscal: ${value}`);
  return s.padStart(intDigits + decDigits, '0');
}

const formatPrice = (v) => digits(v, 8, 2);
const formatQuantity = (v) => digits(v, 5, 3);
const formatPayment = (v) => digits(v, 10, 2);

/** Free text for the printer: no control chars nor "|" (code delimiter), trimmed to the model's limit. */
function cleanText(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(0, max));
}

/**
 * Tax rate of an item (16, 8… or null/0 = exento) → printer slot, from the rates read with S3.
 * The printer decides what slot 1–3 mean; never assume "16 % = slot 1".
 */
function taxSlotFor(rate, s3Taxes) {
  if (rate === null || rate === undefined || Number(rate) === 0) return 0;
  const hit = (s3Taxes || []).find((t) => t.rate !== null && Math.abs(t.rate - Number(rate)) < 0.005);
  if (!hit) {
    const programmed = (s3Taxes || []).filter((t) => t.rate !== null).map((t) => `${t.rate}%`).join(', ') || 'ninguna';
    throw new FiscalDocumentError('tax_not_programmed', `La impresora fiscal no tiene programada la tasa de ${rate}% (tiene: ${programmed})`);
  }
  return hit.slot;
}

/** Bs left unpaid by the partial payments so they can never close the document. */
const PARTIAL_MARGIN = 1;

/** What the printer will total: prices × quantities, plus the tax when its rates are programmed "excluded". */
function expectedTotal(doc, s3Taxes) {
  const included = doc.pricesIncludeTax !== false;
  return doc.items.reduce((sum, it) => {
    const line = Math.round(Number(it.unitPrice) * Number(it.quantity) * 100) / 100;
    const rate = included || !it.taxRate ? 0 : Number(it.taxRate);
    return sum + line * (1 + rate / 100);
  }, 0);
}

/**
 * @param {{
 *   client?: { rif?: string, name?: string },
 *   extraLines?: string[],
 *   items: { description: string, quantity: number, unitPrice: number, taxRate?: number|null }[],
 *   payments: { code: string, amount: number }[],
 *   pricesIncludeTax?: boolean,  // how the printer's rates are programmed (default true); only for the total
 *   finalize199?: boolean,
 * }} doc  unitPrice/amount in Bs, already as the printer expects them (with or without tax: see the POS)
 * @param {{ rif: number, name: number, extraLines: number, extraWidth: number, description: number, paymentMethods: number }} model
 * @param {{ slot: number, rate: number|null }[]} s3Taxes
 * @returns {string[]}
 */
function buildInvoiceCommands(doc, model, s3Taxes) {
  checkDocument(doc, 'La factura');
  return [...clientLines(doc, model), ...extraLines(doc, model), ...itemLines(doc, model, s3Taxes, TAX_CHARS), ...paymentLines(doc, model, s3Taxes)];
}

/**
 * Credit note (nota de crédito) that reverses an invoice of THIS printer family. Same items and payments
 * as an invoice, plus the reference to the original one (number, date and serial of the machine that
 * printed it), all mandatory together with the client RIF and name.
 * @param {object} doc  as in buildInvoiceCommands, plus
 *   reference: { number: number, date: string (ISO, the invoice date), serial: string }, comment?: string
 * @param {'official'|'colon'} variant
 */
function buildCreditNoteCommands(doc, model, s3Taxes, variant = 'official') {
  checkDocument(doc, 'La nota de crédito');
  const ref = doc.reference || {};
  const number = Number(ref.number);
  if (!Number.isInteger(number) || number <= 0) throw new FiscalDocumentError('no_reference', 'Falta el número de la factura que se anula');
  const serial = cleanText(ref.serial, 10);
  if (!serial) throw new FiscalDocumentError('no_reference', 'Falta el serial de la máquina que emitió la factura');
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ref.date || ''));
  if (!d) throw new FiscalDocumentError('no_reference', 'Falta la fecha de la factura que se anula');
  const client = clientLines(doc, model);
  if (client.length < 2) throw new FiscalDocumentError('no_client', 'La nota de crédito necesita el RIF o cédula y el nombre del cliente');

  const reference = variant === 'colon'
    ? ['iF:' + String(number).padStart(8, '0'), 'iD:' + d[3] + d[2] + d[1].slice(2), 'iI:' + serial]
    : ['iF*' + String(number).padStart(11, '0'), 'iD*' + `${d[3]}/${d[2]}/${d[1]}`, 'iI*' + serial];
  const comment = cleanText(doc.comment, model.extraWidth || 40);
  return [
    ...client,
    ...reference,
    ...(comment ? ['A' + comment] : []),
    ...itemLines(doc, model, s3Taxes, CREDIT_TAX_CHARS),
    ...paymentLines(doc, model, s3Taxes),
  ];
}

/** How many leading lines of a credit note are client + reference (a NAK there opened no document). */
function creditNoteHeaderLength(cmds) {
  let n = 0;
  while (n < cmds.length && /^i[RSFDI][*:]/.test(cmds[n])) n++;
  return n;
}

function checkDocument(doc, what) {
  if (!doc || !Array.isArray(doc.items) || doc.items.length === 0) throw new FiscalDocumentError('empty', `${what} no tiene ítems`);
  if (!Array.isArray(doc.payments) || doc.payments.length === 0) throw new FiscalDocumentError('no_payment', `${what} no tiene pagos`);
}

function clientLines(doc, model) {
  const cmds = [];
  const rif = cleanText(doc.client?.rif, model.rif);
  const name = cleanText(doc.client?.name, model.name);
  if (rif) cmds.push('iR*' + rif);
  if (name) cmds.push('iS*' + name);
  return cmds;
}

function extraLines(doc, model) {
  const cmds = [];
  (doc.extraLines || []).slice(0, model.extraLines).forEach((line, i) => {
    const text = cleanText(line, model.extraWidth);
    if (text) cmds.push('i' + String(i).padStart(2, '0') + text);
  });
  return cmds;
}

function itemLines(doc, model, s3Taxes, taxChars) {
  return doc.items.map((it) => {
    const qty = Number(it.quantity);
    if (!(qty > 0)) throw new FiscalDocumentError('bad_quantity', `Cantidad inválida en "${it.description}"`);
    const description = cleanText(it.description, model.description) || 'Producto';
    return taxChars[taxSlotFor(it.taxRate, s3Taxes)] + formatPrice(it.unitPrice) + formatQuantity(qty) + description;
  });
}

/**
 * Payments. What the customer paid can exceed the printer's total (tip, IGTF, rounding). A partial
 * payment that reaches the total CLOSES the document early, so partials are capped below the total and
 * the last one ("1NN") always pays the rest and closes it.
 */
function paymentLines(doc, model, s3Taxes) {
  const cmds = [];
  const maxCode = model.paymentMethods || 16;
  const total = expectedTotal(doc, s3Taxes);
  let accumulated = 0;
  doc.payments.forEach((p, i) => {
    const code = String(p.code ?? '').padStart(2, '0');
    if (!/^\d{2}$/.test(code) || Number(code) < 1 || Number(code) > maxCode) {
      throw new FiscalDocumentError('bad_payment_code', `Medio de pago ${p.code} inválido para esta impresora (01–${String(maxCode).padStart(2, '0')})`);
    }
    if (i === doc.payments.length - 1) {
      cmds.push('1' + code);
      return;
    }
    const room = Math.floor((total - accumulated - PARTIAL_MARGIN) * 100) / 100;
    const amount = Math.min(Math.round(Number(p.amount) * 100) / 100, room);
    if (!(amount > 0)) return; // this method would not leave room for the rest: the last one covers it
    accumulated += amount;
    cmds.push('2' + code + formatPayment(amount));
  });
  if (doc.finalize199) cmds.push('199'); // IGTF mode (flag 50), from third-party sources: validar en el spike
  return cmds;
}

module.exports = {
  buildInvoiceCommands, buildCreditNoteCommands, creditNoteHeaderLength, expectedTotal, taxSlotFor, cleanText,
  formatPrice, formatQuantity, formatPayment, FiscalDocumentError, TAX_CHARS, CREDIT_TAX_CHARS, CREDIT_NOTE_VARIANTS,
};
