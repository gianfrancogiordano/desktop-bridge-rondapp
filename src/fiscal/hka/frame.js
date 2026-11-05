/**
 * The Factory HKA fiscal printer protocol — framing (manual "Protocolos y Comandos" v8.3, Venezuela 2017).
 *
 *   command frame:  STX + DATA + ETX + LRC        LRC = XOR of DATA and ETX (ETX included)
 *   data block:     STX + DATA + ETB + LRC        (multi-block answers; the host ACKs each block, EOT ends)
 *   quick status:   host sends ENQ alone → printer answers STX STS1 STS2 ETX LRC
 *
 * Text goes out in Latin-1 (the Python reference library uses ISO-8859-15; both match for Spanish text).
 * Pure functions only: no I/O here, so everything is testable without a printer.
 */

const STX = 0x02;
const ETX = 0x03;
const EOT = 0x04;
const ENQ = 0x05;
const ACK = 0x06;
const NAK = 0x15;
const ETB = 0x17;
const LF = 0x0a;

/** XOR of every byte of DATA plus the terminator (ETX or ETB). */
function lrc(dataBytes, terminator = ETX) {
  let x = 0;
  for (const b of dataBytes) x ^= b;
  return x ^ terminator;
}

/** Text → bytes as the printer expects them. Characters outside Latin-1 become '?'. */
function encodeText(text) {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c <= 0xff ? c : 0x3f;
  }
  return out;
}

function decodeText(bytes) {
  return Buffer.from(bytes).toString('latin1');
}

/** Full command frame for a text command, e.g. buildFrame('I0X') → 02 49 30 58 03 22 (manual example). */
function buildFrame(command) {
  const data = typeof command === 'string' ? encodeText(command) : Buffer.from(command);
  return Buffer.concat([Buffer.from([STX]), data, Buffer.from([ETX, lrc(data, ETX)])]);
}

/**
 * Looks for one complete frame at the start of `buf` (after skipping noise before STX).
 * @returns {{ data: Buffer, terminator: number, valid: boolean, length: number } | null}
 *          `length` = bytes consumed (including skipped noise); null if the frame is not complete yet.
 */
function parseFrame(buf) {
  const start = buf.indexOf(STX);
  if (start < 0) return null;
  for (let i = start + 1; i < buf.length; i++) {
    const b = buf[i];
    if (b !== ETX && b !== ETB) continue;
    if (i + 1 >= buf.length) return null; // LRC not arrived yet
    const data = buf.subarray(start + 1, i);
    return { data: Buffer.from(data), terminator: b, valid: buf[i + 1] === lrc(data, b), length: i + 2 };
  }
  return null;
}

/** Status answers separate fields with LF. */
function splitFields(text) {
  return text.split(String.fromCharCode(LF)).map(s => s.replace(/\r/g, ''));
}

module.exports = { STX, ETX, EOT, ENQ, ACK, NAK, ETB, LF, lrc, encodeText, decodeText, buildFrame, parseFrame, splitFields };
