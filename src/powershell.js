/**
 * Windows PowerShell, or the fallback when it is missing.
 *
 * Some PCs have a broken PATH (missing System32\WindowsPowerShell\v1.0), so we use the absolute path. Others
 * have no PowerShell at all (stripped Windows builds) or an antivirus that blocks it: then printers, COM ports
 * and the fiscal printer go through the Windows API instead (./winapi.js). PowerShell stays the default
 * because it is the path proven with the real HKA.
 *
 * RONDAPP_WIN_NATIVE=1 forces the Windows API (to test it on a PC that does have PowerShell).
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const IS_WIN = process.platform === 'win32';

function resolvePowerShell() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { return fs.existsSync(full) ? full : null; } catch (_) { return null; }
}

const POWERSHELL = IS_WIN ? resolvePowerShell() : null;

let usePowerShell = IS_WIN && !!POWERSHELL && process.env.RONDAPP_WIN_NATIVE !== '1';

/** true → use PowerShell; false → use ./winapi.js */
function powerShellAvailable() {
  return usePowerShell;
}

/**
 * If `err` means PowerShell could not be launched at all (missing, blocked), switch to the Windows API for
 * the rest of the session and return true so the caller retries that way. Errors from inside a script → false.
 */
function fallBackIfUnlaunchable(err) {
  const code = err && err.code;
  if (!usePowerShell || !['ENOENT', 'EACCES', 'EPERM', 'UNKNOWN'].includes(code)) return false;
  usePowerShell = false;
  logger.warn(`No se pudo ejecutar PowerShell (${code}): se usa la API de Windows desde ahora`);
  return true;
}

function describeBackend() {
  if (!IS_WIN) return 'CUPS';
  return usePowerShell ? `PowerShell (${POWERSHELL})` : 'API de Windows (sin PowerShell)';
}

module.exports = { POWERSHELL, powerShellAvailable, fallBackIfUnlaunchable, describeBackend };
