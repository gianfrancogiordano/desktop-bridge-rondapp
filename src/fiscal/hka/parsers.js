/**
 * Extended status parsers (fields separated by LF). Layouts from the manual v8.3, which documents the
 * DT-230; the HKA-80 may differ ("Diferencias de integración – Reportes y Status" pending from The Factory).
 * Every parser keeps the raw fields so the spike with the real printer can confirm or fix the layout.
 */
const { splitFields } = require('./frame');

/** Drops the echo of the command ("S1", "S3", "SV") when the printer prefixes the answer with it. */
function stripTag(fields, tag) {
  const out = [...fields];
  if (out.length && out[0].startsWith(tag)) out[0] = out[0].slice(tag.length);
  return out;
}

/** Digits → number; empty or non-numeric → null (never 0: a missing counter is not "zero"). */
const num = (s) => {
  const t = String(s ?? '').trim();
  return /^\d+$/.test(t) ? Number(t) : null;
};

/** "123456" + "311026" → ISO-ish local date-time string "2026-10-31T12:34:56" (validar formato en la HKA-80). */
function printerDateTime(hhmmss, ddmmyy) {
  if (!/^\d{6}$/.test(hhmmss || '') || !/^\d{6}$/.test(ddmmyy || '')) return null;
  return `20${ddmmyy.slice(4, 6)}-${ddmmyy.slice(2, 4)}-${ddmmyy.slice(0, 2)}T${hhmmss.slice(0, 2)}:${hhmmss.slice(2, 4)}:${hhmmss.slice(4, 6)}`;
}

const S1_FIELDS = [
  'cashier', 'dailySales', 'lastInvoice', 'invoicesToday', 'lastDebitNote', 'debitNotesToday',
  'lastCreditNote', 'creditNotesToday', 'lastNonFiscal', 'nonFiscalToday', 'fiscalMemoryReports',
  'zReports', 'rif', 'registrationNumber', 'time', 'date',
];

/** S1: counters, RIF and the machine registration number (serial). */
function parseS1(text) {
  const fields = stripTag(splitFields(text), 'S1');
  const raw = {};
  S1_FIELDS.forEach((k, i) => { raw[k] = (fields[i] ?? '').trim(); });
  return {
    cashier: raw.cashier,
    dailySales: num(raw.dailySales) === null ? null : num(raw.dailySales) / 100,
    lastInvoice: num(raw.lastInvoice),
    invoicesToday: num(raw.invoicesToday),
    lastDebitNote: num(raw.lastDebitNote),
    lastCreditNote: num(raw.lastCreditNote),
    zReports: num(raw.zReports),
    rif: raw.rif,
    serial: raw.registrationNumber,
    printerDateTime: printerDateTime(raw.time, raw.date),
    fields,
  };
}

/**
 * S3: the three programmed tax rates. Each line = type (1 char) + rate (4 digits, 2 decimals), e.g. "21600"
 * → type "2", 16.00 %. Lines after the third one are system flags. What each type means (included /
 * excluded) is NOT documented for the HKA-80: kept raw until the spike (validar).
 */
function parseS3(text) {
  const fields = stripTag(splitFields(text), 'S3');
  const taxes = [];
  for (let i = 0; i < 3; i++) {
    const m = /^(\d)(\d{4})$/.exec((fields[i] || '').trim());
    taxes.push(m ? { slot: i + 1, type: m[1], rate: Number(m[2]) / 100, raw: fields[i] } : { slot: i + 1, type: null, rate: null, raw: fields[i] ?? '' });
  }
  return { taxes, flags: fields.slice(3).filter(f => f !== ''), fields };
}

/** SV: model and country (layout not documented for the HKA-80; validar). */
function parseSV(text) {
  const fields = stripTag(splitFields(text), 'SV').map(f => f.trim()).filter(f => f !== '');
  return { model: fields[0] || null, country: fields[1] || null, fields };
}

module.exports = { parseS1, parseS3, parseSV, printerDateTime, S1_FIELDS };
