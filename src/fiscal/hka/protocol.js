/**
 * HKA protocol state machine over a byte transport (see ../transport.js for the interface).
 *
 * Rules from the manual (§9.1 of the plan):
 *  - ACK = frame and command accepted; NAK = bad LRC or command not valid in the current state.
 *  - SILENCE = printer busy (printing). It is NOT an error and the command must NOT be re-sent
 *    (it could duplicate a line): poll with ENQ until the printer is ready instead.
 *  - Data answers come as STX DATA ETX LRC, or as several STX DATA ETB LRC blocks that the host ACKs
 *    one by one, ending with EOT.
 */
const { STX, ETX, EOT, ENQ, ACK, NAK, ETB, buildFrame, parseFrame, decodeText } = require('./frame');
const { decodeStatus } = require('./status');
const { parseS1, parseS3, parseSV } = require('./parsers');
const { findModel } = require('./models');

const DEFAULTS = {
  ackTimeoutMs: 1500, // time to wait for ACK/NAK after a command before calling it "busy"
  frameTimeoutMs: 3000, // time to wait for a complete data frame
  readyTimeoutMs: 20000, // waitReady: max time polling ENQ
  pollMs: 250,
};

class FiscalProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class HkaProtocol {
  /**
   * @param {import('../transport').Transport} transport
   * @param {Partial<typeof DEFAULTS>} [opts]
   */
  constructor(transport, opts = {}) {
    this.t = transport;
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Reads until a complete frame arrives (or times out). Leading ACK/noise bytes are skipped. */
  async readFrame(timeoutMs = this.opts.frameTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let buf = Buffer.alloc(0);
    while (Date.now() < deadline) {
      const chunk = await this.t.read(Math.max(1, deadline - Date.now()));
      if (chunk && chunk.length) buf = Buffer.concat([buf, chunk]);
      if (buf.length === 1 && buf[0] === EOT) return { eot: true };
      const f = parseFrame(buf);
      if (f) return f;
    }
    throw new FiscalProtocolError('timeout', 'La impresora fiscal no respondió a tiempo');
  }

  /** Quick status. */
  async enq() {
    await this.t.write(Buffer.from([ENQ]));
    const f = await this.readFrame();
    if (f.eot || f.data.length < 2) throw new FiscalProtocolError('bad_status', 'Respuesta de estado inválida');
    if (!f.valid) throw new FiscalProtocolError('bad_lrc', 'Respuesta de estado con LRC inválido');
    return decodeStatus(f.data[0], f.data[1]);
  }

  /**
   * Polls ENQ while the printer is busy (it does not answer while printing) and returns its status as soon
   * as it answers. The caller checks `ready`: an error (no paper…) or an open document will not clear by
   * waiting, so they are returned right away instead of polling until the timeout.
   */
  async waitReady(timeoutMs = this.opts.readyTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return await this.enq();
      } catch (e) {
        if (e.code !== 'timeout') throw e;
      }
      await new Promise(r => setTimeout(r, this.opts.pollMs));
    }
    throw new FiscalProtocolError('busy', 'La impresora fiscal sigue ocupada');
  }

  /**
   * Sends a command that only answers ACK/NAK (items, payments, reports…).
   * @returns {Promise<'ack' | 'nak' | 'busy'>}  'busy' = no answer: do NOT re-send, poll with waitReady().
   */
  async command(text) {
    await this.t.write(buildFrame(text));
    const deadline = Date.now() + this.opts.ackTimeoutMs;
    while (Date.now() < deadline) {
      const chunk = await this.t.read(Math.max(1, deadline - Date.now()));
      if (!chunk || !chunk.length) continue;
      if (chunk.includes(ACK)) return 'ack';
      if (chunk.includes(NAK)) return 'nak';
    }
    return 'busy';
  }

  /** Sends a status/report query and returns the text of its answer (all blocks joined). */
  async query(text) {
    await this.t.write(buildFrame(text));
    const parts = [];
    for (;;) {
      const f = await this.readFrame();
      if (f.eot) break;
      if (!f.valid) {
        await this.t.write(Buffer.from([NAK]));
        throw new FiscalProtocolError('bad_lrc', `Respuesta a ${text} con LRC inválido`);
      }
      parts.push(decodeText(f.data));
      if (f.terminator === ETX) break;
      await this.t.write(Buffer.from([ACK])); // ETB: ask for the next block
    }
    return parts.join('');
  }

  /**
   * Everything the plan asks to read when connecting (§9.3), with no fiscal side effects:
   * quick status, model (SV), counters/RIF/serial (S1) and tax rates (S3). S5 is kept raw.
   */
  async readInfo() {
    const status = await this.enq();
    const sv = parseSV(await this.query('SV'));
    const s1 = parseS1(await this.query('S1'));
    const s3 = parseS3(await this.query('S3'));
    let s5Raw = null;
    try {
      s5Raw = await this.query('S5');
    } catch (e) {
      s5Raw = null; // optional: not every firmware answers S5
    }
    const model = findModel(sv.model);
    return { status, sv, model, s1, s3, s5Raw };
  }
}

module.exports = { HkaProtocol, FiscalProtocolError, DEFAULTS, STX, ETX };
