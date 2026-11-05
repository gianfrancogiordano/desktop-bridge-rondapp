/**
 * In-memory HKA fiscal printer that implements the Transport interface. It answers like a real HKA-80
 * (as far as the manual and the reference libraries say) so the protocol and the bridge messages can be
 * tested without hardware. Knobs (`busyFor`, `nak`, `paperOut`…) simulate the failure cases of §6.
 */
const { STX, ETX, ENQ, ACK, NAK, EOT, ETB, LF, lrc, encodeText, parseFrame, decodeText } = require('./frame');

const lfJoin = (fields) => fields.join(String.fromCharCode(LF));

class HkaSimulator {
  constructor(opts = {}) {
    this.model = opts.model || 'HKA80';
    this.serial = opts.serial || 'Z1F1234567';
    this.rif = opts.rif || 'J123456789';
    this.lastInvoice = opts.lastInvoice ?? 41;
    this.lastCreditNote = opts.lastCreditNote ?? 2;
    // Which credit-note reference lines this firmware takes: 'official' ("iF*…") or 'colon' ("iF:…")
    this.creditNoteVariant = opts.creditNoteVariant || 'official';
    this.zReports = opts.zReports ?? 12;
    this.taxes = opts.taxes || ['21600', '20800', '23100']; // type + rate (validar significado del tipo)
    this.sts1 = 0x60; // fiscal, idle
    this.sts2 = opts.paperOut ? 0x41 : 0x40;
    this.busyFor = 0; // next N commands get no answer at all (printer busy)
    this.nakCommands = new Set(opts.nak || []);
    this.multiBlock = !!opts.multiBlock; // answer status queries in two ETB blocks
    this.silent = !!opts.silent; // disconnected: nothing ever answers
    this.totalFactor = opts.totalFactor ?? 1; // the printer totals differently from the POS (rounding…)
    this.pricesIncludeTax = opts.pricesIncludeTax !== false; // how the rates are programmed (S2 totals)
    this.noS2 = !!opts.noS2; // an older firmware that NAKs the S2 queries
    // IGTF (v8.5): true = flag 50 en 01 (divisas 20–24 cobran 3 %, cierre con 199), false = flag 50 en 00.
    // Con un valor, S3 sale en el formato v8.5 (ancho fijo con IGTF y flags); sin él, en el de v8.3.
    this.igtfMode = opts.igtfMode;
    this.igtfRate = opts.igtfRate ?? 3;
    this.acc = { invoice: { base: 0, igtf: 0 }, credit_note: { base: 0, igtf: 0 } }; // U0X (del día)
    this.day = this._emptyDay(); // U0X/U0Z: exento y base/impuesto por tasa del día, de facturas y de NC
    this.nakMatch = opts.nakMatch || null; // RegExp: NAK the first command that matches
    this.cutAfter = opts.cutAfter ?? null; // RegExp: the link dies right after this command (it IS processed)
    this.cutBefore = opts.cutBefore ?? null; // RegExp: the link dies before this command (NOT processed)
    this.outageWrites = opts.outageWrites ?? 3; // after a cut, this many writes get no answer (then it is back)
    this._outage = 0;
    this.received = []; // commands received (decoded), for assertions
    this.printed = []; // closed documents: { number, lines }
    this._in = Buffer.alloc(0);
    this._out = [];
    this._pendingBlocks = [];
  }

  _frame(text, terminator = ETX) {
    const data = encodeText(text);
    return Buffer.concat([Buffer.from([STX]), data, Buffer.from([terminator, lrc(data, terminator)])]);
  }

  _answer(cmd) {
    switch (cmd) {
      case 'SV': return lfJoin(['SV' + this.model, 'VE']);
      case 'S1': return lfJoin([
        'S1' + '01', '00000000000150000', String(this.lastInvoice).padStart(8, '0'), '00003',
        '00000000', '00000', String(this.lastCreditNote).padStart(8, '0'), '00000', '00000010', '00000', '0000', String(this.zReports).padStart(4, '0'),
        this.rif, this.serial, '153000', '041126',
      ]);
      case 'S3': return this.igtfMode === undefined
        ? lfJoin(['S3' + this.taxes[0], this.taxes[1], this.taxes[2], '00000000000000000000'])
        : 'S3' + this.taxes.join('') + '2' + String(Math.round(this.igtfRate * 100)).padStart(4, '0')
          + Array.from({ length: 64 }, (_, n) => (n === 50 ? (this.igtfMode ? '01' : '00') : n === 63 ? (this.igtfMode ? '17' : '00') : '00')).join('');
      case 'U0X': return this._u0x();
      case 'U0Z': return this._u0x().replace(/^U0X/, 'U0Z');
      case 'S5': return lfJoin(['S5' + this.rif, this.serial, '0005']);
      case 'S2': case 'S2E': case 'S21': case 'S22': case 'S23': return this._s2(cmd);
      default: return null;
    }
  }

  /** S2 / S2E / S2n of the open document, from its items (rates as programmed: included or excluded) */
  _s2(tag) {
    const amt = (v) => ' ' + String(Math.round(v * 100)).padStart(13, '0');
    const slotOf = { ' ': 0, '!': 1, '"': 2, '#': 3 };
    let base = 0, tax = 0, items = 0;
    for (const cmd of this._doc || []) {
      const m = /^(?:d([0-3])|([ !"#]))(\d{10})(\d{8})/.exec(cmd);
      if (!m) continue;
      const slot = m[1] !== undefined ? Number(m[1]) : slotOf[m[2]];
      if (tag === 'S2E' && slot !== 0) continue;
      if (/^S2\d$/.test(tag) && slot !== Number(tag[2])) continue;
      const line = Math.round((Number(m[3]) / 100) * (Number(m[4]) / 1000) * 100) / 100;
      const rate = slot ? Number(this.taxes[slot - 1].slice(1)) / 10000 : 0;
      const b = this.pricesIncludeTax ? Math.round((line / (1 + rate)) * 100) / 100 : line;
      const t = this.pricesIncludeTax ? line - b : Math.round(line * rate * 100) / 100;
      base += b; tax += t; items += 1;
    }
    const docType = this.sts1 !== 0x61 ? 0 : this._kind === 'credit_note' ? 2 : 1;
    return lfJoin([tag + amt(base), amt(tax), amt(0), String(items).padStart(6, '0'), amt(base + tax), '0000', String(docType)]);
  }

  _emptyDay() {
    const block = () => ({ exempt: 0, rates: [{ base: 0, tax: 0 }, { base: 0, tax: 0 }, { base: 0, tax: 0 }] });
    return { invoice: block(), credit_note: block() };
  }

  /** U0X: cabecera de 56 + acumulados de 18 dígitos; con IGTF (tramas ampliadas) 30 montos, sin él 21 */
  _u0x() {
    const amt = (v) => String(Math.round(v * 100)).padStart(18, '0');
    const head = String(this.zReports + 1).padStart(4, '0') + '041126' + '1530' + String(this.lastInvoice).padStart(8, '0')
      + '041126' + '1530' + String(this.lastCreditNote).padStart(8, '0') + '00000000' + '00000010';
    const amounts = Array.from({ length: this.igtfMode ? 30 : 21 }, () => 0);
    const put = (k, b) => { amounts[k] = b.exempt; b.rates.forEach((r, i) => { amounts[k + 1 + 2 * i] = r.base; amounts[k + 2 + 2 * i] = r.tax; }); };
    put(0, this.day.invoice);
    put(14, this.day.credit_note);
    if (this.igtfMode) {
      amounts[21] = this.acc.invoice.base; amounts[25] = this.acc.invoice.igtf;
      amounts[26] = this.acc.credit_note.base; amounts[27] = this.acc.credit_note.igtf;
    }
    return 'U0X' + head + amounts.map(amt).join('');
  }

  /** Un pago: en modo IGTF las divisas (20–24) cubren hasta lo que falta y la máquina suma su 3 % */
  _pay(code, amount) {
    const remaining = Math.max(0, (this._total || 0) - (this._covered || 0));
    const foreign = this.igtfMode && Number(code) >= 20 && Number(code) <= 24;
    const covers = amount === null ? remaining : Math.min(amount, remaining);
    if (foreign) {
      this._igtfBase = (this._igtfBase || 0) + covers;
      this._igtf = (this._igtf || 0) + Math.round(covers * this.igtfRate) / 100;
    }
    this._covered = (this._covered || 0) + (amount === null ? remaining : amount);
    this._paid = (this._paid || 0) + (amount === null ? remaining + (foreign ? Math.round(remaining * this.igtfRate) / 100 : 0) : amount);
    const due = (this._total || 0) + (this._igtf || 0);
    if (amount === null || this._paid + 0.005 >= due) {
      if (this.igtfMode) this._awaiting199 = true; // con flag 50 en 01 el documento cierra con 199
      else this._closeDocument();
    }
  }

  _closeDocument() {
    this.sts1 = 0x60;
    const kind = this._kind || 'invoice';
    const number = kind === 'credit_note' ? ++this.lastCreditNote : ++this.lastInvoice;
    // Acumulados del día (lo que el S2 de este documento dice antes de cerrarlo)
    const read = (tag) => this._s2(tag).split(String.fromCharCode(LF)).map(f => Number(f.replace(/^S2\w?/, '').trim()) / 100);
    if (this._doc && !this._doc.includes('ANULADA') && this._doc.some(c => /^(?:d[0-3]|[ !"#])\d{10}/.test(c))) {
      const day = this.day[kind];
      day.exempt += read('S2E')[0];
      [1, 2, 3].forEach((slot, i) => { const [b, t] = read('S2' + slot); day.rates[i].base += b; day.rates[i].tax += t; });
    }
    this.acc[kind].base += this._igtfBase || 0;
    this.acc[kind].igtf += this._igtf || 0;
    this.printed.push({ kind, number, lines: this._doc, igtf: this._igtf || 0 });
    this._doc = [];
    this._kind = null;
    this._total = 0;
    this._paid = 0;
    this._covered = 0;
    this._igtf = 0;
    this._igtfBase = 0;
    this._awaiting199 = false;
  }

  _handleCommand(cmd) {
    if (this.cutBefore && this.cutBefore.test(cmd)) { this.cutBefore = null; this._outage = this.outageWrites; return; }
    this.received.push(cmd);
    if (this.busyFor > 0) { this.busyFor--; return; }
    if (this.noS2 && /^S2/.test(cmd)) { this._out.push(Buffer.from([NAK])); return; }
    if (this.nakCommands.has(cmd) || (this.nakMatch && this.nakMatch.test(cmd))) {
      if (this.nakMatch && this.nakMatch.test(cmd)) this.nakMatch = null;
      this._out.push(Buffer.from([NAK]));
      return;
    }
    const answer = this._answer(cmd);
    if (answer !== null) {
      if (this.multiBlock) {
        const mid = Math.ceil(answer.length / 2);
        this._out.push(this._frame(answer.slice(0, mid), ETB));
        this._pendingBlocks = [this._frame(answer.slice(mid), ETX)];
      } else {
        this._out.push(this._frame(answer));
      }
      return;
    }
    // Document commands: items open a fiscal document; payments close it; "7" annuls it (uses a number).
    this._doc = this._doc || [];
    const item = /^([ !"#]|d[0-3])(\d{10})(\d{8})(.*)$/.exec(cmd);
    const reference = /^i[FDI]([*:])/.exec(cmd);
    if (reference && reference[1] !== (this.creditNoteVariant === 'colon' ? ':' : '*')) {
      this._out.push(Buffer.from([NAK])); // this firmware does not know that variant
      return;
    }
    if (item) {
      if (this.sts1 !== 0x61) this._kind = item[1].startsWith('d') ? 'credit_note' : 'invoice';
      this.sts1 = 0x61;
      this._total = (this._total || 0) + (Number(item[2]) / 100) * (Number(item[3]) / 1000) * this.totalFactor;
      this._doc.push(cmd);
    } else if (/^i(R\*|S\*|\d\d)/.test(cmd) || reference || (/^A/.test(cmd) && this.sts1 !== 0x61)) {
      this._doc.push(cmd);
    } else if (cmd === 'I0Z' && this.sts1 !== 0x61) {
      // Cierre Z: un Z más y los acumulados del día vuelven a cero
      this.zReports += 1;
      this.acc = { invoice: { base: 0, igtf: 0 }, credit_note: { base: 0, igtf: 0 } };
      this.day = this._emptyDay();
      this.zPrinted = (this.zPrinted || 0) + 1;
    } else if (cmd === 'I0Z' && this.sts1 === 0x61) {
      this._out.push(Buffer.from([NAK])); // con un documento abierto no hay Z
      return;
    } else if (cmd === '199' && this._awaiting199) {
      this._doc.push(cmd);
      this._closeDocument();
    } else if (/^[12]\d\d/.test(cmd) && (this.sts1 !== 0x61 || this._awaiting199)) {
      this._out.push(Buffer.from([NAK])); // a payment with no document open (or already paid) is rejected
      return;
    } else if (/^[12](2[0-4])/.test(cmd) && this.igtfMode === false) {
      this._out.push(Buffer.from([NAK])); // flag 50 en 00: los medios de divisas están bloqueados
      return;
    } else if (/^2\d\d\d{12}$/.test(cmd) && this.sts1 === 0x61) {
      this._doc.push(cmd);
      this._pay(cmd.slice(1, 3), Number(cmd.slice(3)) / 100);
    } else if (/^1\d\d$/.test(cmd) && this.sts1 === 0x61) {
      this._doc.push(cmd);
      this._pay(cmd.slice(1, 3), null);
    } else if (cmd === '7' && this.sts1 === 0x61) {
      this._doc.push('ANULADA');
      this._closeDocument();
    }
    this._out.push(Buffer.from([ACK]));
    if (this.cutAfter && this.cutAfter.test(cmd)) { this.cutAfter = null; this._out = []; this._outage = this.outageWrites; }
  }

  async write(bytes) {
    if (this.silent) return;
    if (this._outage > 0) { this._outage--; return; }
    if (bytes.length === 1 && bytes[0] === ENQ) {
      if (this.busyFor > 0) { this.busyFor--; return; }
      this._out.push(this._frame(String.fromCharCode(this.sts1, this.sts2)));
      return;
    }
    if (bytes.length === 1 && bytes[0] === ACK) {
      // host confirms a block: send the next one or EOT
      this._out.push(this._pendingBlocks.length ? this._pendingBlocks.shift() : Buffer.from([EOT]));
      return;
    }
    if (bytes.length === 1 && bytes[0] === NAK) return;
    this._in = Buffer.concat([this._in, bytes]);
    for (let f = parseFrame(this._in); f; f = parseFrame(this._in)) {
      this._in = this._in.subarray(f.length);
      if (!f.valid) { this._out.push(Buffer.from([NAK])); continue; }
      this._handleCommand(decodeText(f.data));
    }
  }

  async read(timeoutMs) {
    if (this._out.length) return this._out.shift();
    // Nothing to say: behave like a real port and wait out the timeout (capped so tests stay fast)
    await new Promise(r => setTimeout(r, Math.min(timeoutMs, 5)));
    return Buffer.alloc(0);
  }

  async close() {}
}

module.exports = { HkaSimulator };
