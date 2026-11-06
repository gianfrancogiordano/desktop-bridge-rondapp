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

/**
 * S1 layouts (manual v8.5, Tabla 45). 'large' = SRP-812, DT-230, HKA-80, P3100DL, PP9, PP9-PLUS, TD1140
 * (16 fields, with debit notes); 'small' = SRP-350, HSP7000, TD1125, HKA-112, KUBE (14 fields, the credit
 * notes at the end). In v8.5 the Z counter comes BEFORE the fiscal-memory reports counter; the v8.3 manual
 * had them the other way round: `withZCounter` settles it with the next Z number of U0X/U0Z.
 */
const S1_FIELDS = [
  'cashier', 'dailySales', 'lastInvoice', 'invoicesToday', 'lastDebitNote', 'debitNotesToday',
  'lastCreditNote', 'creditNotesToday', 'lastNonFiscal', 'nonFiscalToday', 'zReports',
  'fiscalMemoryReports', 'rif', 'registrationNumber', 'time', 'date',
];
const S1_FIELDS_SMALL = [
  'cashier', 'dailySales', 'lastInvoice', 'invoicesToday', 'lastNonFiscal', 'nonFiscalToday', 'zReports',
  'fiscalMemoryReports', 'rif', 'registrationNumber', 'time', 'date', 'lastCreditNote', 'creditNotesToday',
];

/** S1: counters, RIF and the machine registration number (serial). The layout is told by the field count. */
function parseS1(text) {
  const fields = stripTag(splitFields(text), 'S1');
  const layout = fields.filter(f => f.trim() !== '').length === S1_FIELDS_SMALL.length ? S1_FIELDS_SMALL : S1_FIELDS;
  const raw = {};
  layout.forEach((k, i) => { raw[k] = (fields[i] ?? '').trim(); });
  return {
    cashier: raw.cashier,
    dailySales: num(raw.dailySales) === null ? null : num(raw.dailySales) / 100,
    lastInvoice: num(raw.lastInvoice),
    invoicesToday: num(raw.invoicesToday),
    lastDebitNote: num(raw.lastDebitNote ?? ''),
    lastCreditNote: num(raw.lastCreditNote),
    zReports: num(raw.zReports),
    fiscalMemoryReports: num(raw.fiscalMemoryReports),
    rif: raw.rif,
    serial: raw.registrationNumber,
    printerDateTime: printerDateTime(raw.time, raw.date),
    layout: layout === S1_FIELDS_SMALL ? 'small' : 'large',
    fields,
  };
}

/** The two 4-digit counters of S1 swapped (firmware with the v8.3 order) */
const swapZ = (s1) => ({ ...s1, zReports: s1.fiscalMemoryReports, fiscalMemoryReports: s1.zReports, zSwapped: !s1.zSwapped });

/**
 * Which 4-digit S1 counter is the Z one, from the next Z of U0X/U0Z (`nextZ` − 1 = Z done). Returns s1 as
 * is when it already matches or nothing can be told; swapped (`zSwapped: true`) when the other one matches.
 */
function withZCounter(s1, nextZ) {
  if (!s1 || !Number.isInteger(nextZ)) return s1;
  if (s1.zReports === nextZ - 1) return s1;
  if (s1.fiscalMemoryReports === nextZ - 1) return swapZ(s1);
  return s1;
}

/**
 * S3: tax rates, IGTF and user flags. Two layouts:
 *  - v8.3 (DT-230 tables): LF-separated lines, each type (1 char) + rate (4 digits, 2 decimals), e.g. "21600".
 *  - v8.5 (2022, HKA-80 by direct protocol, Tabla 53): fixed width, no separators —
 *    "S3" · type+rate ×3 · IGTF type (pos 17) + rate (18–21) · flags from pos 22, two digits each (flag 00, 01…).
 * The type digit is contradictory in the manual (Tabla 19: 1 excluded / 2 included; Tabla 53: the reverse):
 * kept raw, never used to guess whether prices include the tax (validar en el spike).
 */
function parseS3(text) {
  const fields = stripTag(splitFields(text), 'S3');
  const rate = (raw) => {
    const m = /^(\d)(\d{4})$/.exec(String(raw || '').trim());
    return m ? { type: m[1], rate: Number(m[2]) / 100 } : { type: null, rate: null };
  };
  const lines = fields.map(f => f.trim());
  const lfLayout = lines.slice(0, 3).every(f => /^\d{5}$/.test(f));
  let rates, igtfRaw = '', flagsText = '';
  if (lfLayout) {
    rates = lines.slice(0, 3);
    if (/^\d{5}$/.test(lines[3] || '')) { igtfRaw = lines[3]; flagsText = lines.slice(4).join(''); }
    else flagsText = lines.slice(3).join('');
  } else {
    const c = lines.join('').replace(/\s+/g, '');
    rates = [c.slice(0, 5), c.slice(5, 10), c.slice(10, 15)];
    igtfRaw = c.slice(15, 20);
    flagsText = c.slice(20);
  }
  const taxes = rates.map((raw, i) => ({ slot: i + 1, ...rate(raw), raw: raw ?? '' }));
  const igtf = rate(igtfRaw);
  return {
    taxes,
    igtf: { type: igtf.type, rate: igtf.rate, raw: igtfRaw },
    /** flags[n] = two-digit value of flag n ("00", "01"…), only the ones the printer sent */
    flags: /^\d+$/.test(flagsText) ? Object.fromEntries((flagsText.match(/\d{2}/g) || []).map((v, n) => [n, v])) : {},
    fields,
  };
}

/** Flag 50 = 01 → IGTF mode (payments 20–24 charge IGTF, documents close with "199"); 00 → off; unknown → null */
function igtfModeOf(s3) {
  const f = s3?.flags?.[50];
  return f === '01' ? true : f === '00' ? false : null;
}

/**
 * S2 / S2E / S21–S23 (manual v8.3, p. 59–62): what the printer has accumulated in the document that is open
 * right now — S2 all of it, S2E the exempt part, S2n tax rate n. Amounts have 11 integers + 2 decimals, in
 * Bs, as the printer computed them (its own rounding). With no document open every amount is zero.
 * Fields: base · tax · (future use) · item count · amount to pay · payments made · document type (S2 only).
 */
function parseS2(text, tag = 'S2') {
  const fields = stripTag(splitFields(text), tag).map(f => f.trim());
  const amount = (i) => (num(fields[i]) === null ? null : num(fields[i]) / 100);
  return {
    base: amount(0),
    tax: amount(1),
    items: num(fields[3]),
    toPay: amount(4),
    payments: num(fields[5]),
    docType: num(fields[6]),
    fields,
  };
}

/** SV: model and country (layout not documented for the HKA-80; validar). */
function parseSV(text) {
  const fields = stripTag(splitFields(text), 'SV').map(f => f.trim()).filter(f => f !== '');
  return { model: fields[0] || null, country: fields[1] || null, fields };
}

/**
 * U0X / U0Z (v8.5, Tablas 62–65): the X (or Z) report as data, without printing. Fixed width by direct
 * protocol: next Z (4) · last Z date (6) · time (4) · last invoice (8) · its date (6) · time (4) · last NC (8)
 * · last ND (8) · last non-fiscal (8), then the accumulators (18 digits = 16 + 2 decimals, Bs) from pos 56:
 * exempt, base/tax of rates 1–3 (sales, then ND, then NC)… and, from index 21, base IGTF (434), perceived tax
 * of sales/ND/NC, IGTF value (506), base and IGTF of NC (524, 542) and of ND (560, 578). The IGTF fields only
 * come with the extended frames (flag 63); without them `igtf` is null.
 */
function parseU0X(text, tag = 'U0X') {
  let c = String(text || '');
  if (c.startsWith(tag)) c = c.slice(tag.length);
  c = c.replace(/[\n\r ]/g, '');
  // Amount width: 18 (16 + 2) with the extended frames of flag 63, 13 (11 + 2) with the reduced ones. The
  // manual gives the layout only for the extended one: the width is told by the length (validar en la HKA-80).
  const START = 56;
  const rest = Math.max(0, c.length - START);
  const AMOUNT = rest % 18 === 0 && rest >= 18 * 21 ? 18 : rest % 13 === 0 && rest >= 13 * 21 ? 13 : 18;
  const amount = (k) => {
    const raw = c.slice(START + AMOUNT * k, START + AMOUNT * (k + 1));
    return raw.length === AMOUNT && /^\d+$/.test(raw) ? Number(raw) / 100 : null;
  };
  const pair = (b, v) => {
    const base = amount(b), value = amount(v);
    return base === null || value === null ? null : { base, igtf: value };
  };
  /** Exempt + base/tax of the three rates, from amount index `k` (sales 0, debit notes 7, credit notes 14) */
  const block = (k) => {
    const values = Array.from({ length: 7 }, (_, i) => amount(k + i));
    if (values.some(v => v === null)) return null;
    return { exempt: values[0], rates: [1, 2, 3].map((slot, i) => ({ slot, base: values[1 + 2 * i], tax: values[2 + 2 * i] })) };
  };
  const ddmmyy = (s) => (/^\d{6}$/.test(s) ? `20${s.slice(4, 6)}-${s.slice(2, 4)}-${s.slice(0, 2)}` : null);
  return {
    /** U0Z read before printing the Z: the number of the Z about to be printed */
    nextZ: num(c.slice(0, 4)),
    lastZDate: ddmmyy(c.slice(4, 10)),
    lastInvoice: num(c.slice(14, 22)),
    lastInvoiceDate: ddmmyy(c.slice(22, 28)),
    lastCreditNote: num(c.slice(32, 40)),
    lastDebitNote: num(c.slice(40, 48)),
    sales: block(0),
    debitNotes: block(7),
    creditNotes: block(14),
    amountWidth: AMOUNT,
    igtf: c.length >= START + AMOUNT * 30
      ? { invoices: pair(21, 25), creditNotes: pair(26, 27), debitNotes: pair(28, 29) }
      : null,
    length: c.length,
  };
}

module.exports = { parseS1, parseS2, parseS3, parseSV, parseU0X, igtfModeOf, withZCounter, swapZ, printerDateTime, S1_FIELDS, S1_FIELDS_SMALL };
