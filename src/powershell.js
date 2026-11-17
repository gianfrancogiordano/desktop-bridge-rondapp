/**
 * Absolute path to Windows PowerShell. Some PCs have a broken PATH (missing System32\WindowsPowerShell\v1.0),
 * so spawning a bare 'powershell.exe' fails with ENOENT and nothing (printers, COM ports, fiscal) works.
 */
const fs = require('fs');
const path = require('path');

function resolvePowerShell() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(full)) return full; } catch (_) { /* fall back to PATH */ }
  return 'powershell.exe';
}

module.exports = { POWERSHELL: process.platform === 'win32' ? resolvePowerShell() : 'powershell.exe' };
