/**
 * Byte transport between the protocol and a fiscal printer.
 *
 * @typedef {Object} Transport
 * @property {(bytes: Buffer) => Promise<void>} write  sends raw bytes
 * @property {(timeoutMs: number) => Promise<Buffer>} read  resolves with the bytes received before the
 *           timeout (an empty Buffer if nothing arrived). Never rejects on timeout: silence is information.
 * @property {() => Promise<void>} close
 *
 * Implementations: ./serial-powershell.js (real COM port on Windows) and ./hka/simulator.js (tests).
 */
module.exports = {};
