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
      case 'S3': return lfJoin(['S3' + this.taxes[0], this.taxes[1], this.taxes[2], '00000000000000000000']);
      case 'S5': return lfJoin(['S5' + this.rif, this.serial, '0005']);
      default: return null;
    }
  }

  _closeDocument() {
    this.sts1 = 0x60;
    const kind = this._kind || 'invoice';
    const number = kind === 'credit_note' ? ++this.lastCreditNote : ++this.lastInvoice;
    this.printed.push({ kind, number, lines: this._doc });
    this._doc = [];
    this._kind = null;
    this._total = 0;
    this._paid = 0;
  }

  _handleCommand(cmd) {
    if (this.cutBefore && this.cutBefore.test(cmd)) { this.cutBefore = null; this._outage = this.outageWrites; return; }
    this.received.push(cmd);
    if (this.busyFor > 0) { this.busyFor--; return; }
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
    } else if (/^[12]\d\d/.test(cmd) && this.sts1 !== 0x61) {
      this._out.push(Buffer.from([NAK])); // a payment with no document open is rejected
      return;
    } else if (/^2\d\d\d{12}$/.test(cmd) && this.sts1 === 0x61) {
      this._paid = (this._paid || 0) + Number(cmd.slice(3)) / 100;
      this._doc.push(cmd);
      if (this._paid + 0.005 >= this._total) this._closeDocument();
    } else if (/^1\d\d$/.test(cmd) && this.sts1 === 0x61) {
      this._doc.push(cmd);
      this._closeDocument();
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
