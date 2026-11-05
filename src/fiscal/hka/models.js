/**
 * HKA protocol family: per-model differences (PROVIDENCIA_00093_ANALISIS_Y_PLAN.md §4.2, from the manual's
 * character table). The driver trims texts to these lengths and offers 16 or 24 payment codes.
 * `status`: 'tested' once a real customer used it for invoice + credit note + Z; until then 'untested'.
 */
const MODELS = [
  { id: 'HKA-80', maker: 'The Factory HKA', paymentMethods: 24, debitNote: true, rif: 40, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 127, status: 'untested' },
  { id: 'HKA-112', maker: 'The Factory HKA', paymentMethods: 16, debitNote: false, rif: 40, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 116, status: 'untested' },
  { id: 'SRP-812', maker: 'Bixolon', paymentMethods: 24, debitNote: true, rif: 40, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 127, status: 'untested' },
  { id: 'SRP-350', maker: 'Bixolon', paymentMethods: 16, debitNote: false, rif: 47, name: 43, extraLines: 10, extraWidth: 56, comment: 40, description: 37, status: 'untested' },
  { id: 'SRP-270', maker: 'Bixolon', paymentMethods: 16, debitNote: false, rif: 35, name: 31, extraLines: 10, extraWidth: 40, comment: 40, description: 26, status: 'untested' },
  { id: 'SRP-280', maker: 'Bixolon', paymentMethods: 16, debitNote: false, rif: 33, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 120, status: 'untested' },
  { id: 'SPP-R200II', maker: 'Bixolon', paymentMethods: 24, debitNote: true, rif: 40, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 127, status: 'untested' },
  { id: 'DT-230', maker: 'Dascom', paymentMethods: 24, debitNote: true, rif: 40, name: 40, extraLines: 10, extraWidth: 40, comment: 40, description: 127, status: 'untested' },
  { id: 'TALLY-1125', maker: 'Dascom', paymentMethods: 16, debitNote: false, rif: 29, name: 38, extraLines: 2, extraWidth: 38, comment: 39, description: 118, status: 'untested' },
  { id: 'PP9', maker: 'Aclas', paymentMethods: 24, debitNote: true, rif: 38, name: 34, extraLines: 10, extraWidth: 40, comment: 40, description: 120, status: 'untested' },
  { id: 'PP1F3', maker: 'Aclas', paymentMethods: 16, debitNote: false, rif: 23, name: 19, extraLines: 10, extraWidth: 32, comment: 31, description: 33, status: 'untested' },
  { id: 'P3100DL', maker: 'Pantum', paymentMethods: 24, debitNote: true, rif: 24, name: 20, extraLines: 2, extraWidth: 33, comment: 27, description: 127, status: 'untested' },
  { id: 'HSP7000', maker: 'Star', paymentMethods: 16, debitNote: false, rif: 47, name: 43, extraLines: 10, extraWidth: 50, comment: 40, description: 120, status: 'untested' },
  { id: 'ML1120', maker: 'OKI', paymentMethods: 16, debitNote: false, rif: 30, name: 26, extraLines: 3, extraWidth: 39, comment: 40, description: 105, status: 'untested' },
  { id: 'KUBE', maker: 'Custom', paymentMethods: 16, debitNote: false, rif: 47, name: 43, extraLines: 10, extraWidth: 56, comment: 40, description: 120, status: 'untested' },
];

/** The most restrictive limits of the family: used when the model is not recognised. */
const SAFE_DEFAULT = {
  id: 'unknown', maker: null, paymentMethods: 16, debitNote: false,
  rif: 23, name: 19, extraLines: 2, extraWidth: 32, comment: 27, description: 26, status: 'unknown',
};

const norm = (s) => String(s || '').toUpperCase().replace(/[\s_]/g, '').replace(/-/g, '');

/** Model from the SV answer (free text such as "HKA80" or "SRP-812"): tolerant to dashes and spaces. */
function findModel(svModel) {
  const n = norm(svModel);
  if (!n) return SAFE_DEFAULT;
  return MODELS.find(m => n.includes(norm(m.id))) || SAFE_DEFAULT;
}

module.exports = { MODELS, SAFE_DEFAULT, findModel };
