const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // rotate at 1 MB

let logDir = null;
let logFile = null;

/** Must be called once with a writable directory (Electron's app.getPath('logs')). */
function init(dir) {
  logDir = dir;
  logFile = path.join(dir, 'bridge.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, path.join(dir, 'bridge.old.log'));
    }
  } catch (_) { /* logging must never crash the app */ }
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ` + args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
    return String(a);
  }).join(' ');
  try { if (logFile) fs.appendFileSync(logFile, line + '\n'); } catch (_) { /* ignore */ }
  // eslint-disable-next-line no-console
  (level === 'ERROR' ? console.error : console.log)(line);
}

module.exports = {
  init,
  getDir: () => logDir,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
