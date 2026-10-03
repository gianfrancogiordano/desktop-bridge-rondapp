/**
 * OS printer access WITHOUT native addons.
 *
 *  - Windows: PowerShell (Get-CimInstance for listing, winspool.drv P/Invoke for RAW printing)
 *  - macOS / Linux: CUPS command line tools (lpstat / lp -o raw)
 *
 * Avoiding node-gyp/native modules removes the most fragile part of the previous
 * pkg-based build (the .node addon failing to load inside the packaged binary).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger');

const IS_WIN = process.platform === 'win32';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    // LC_ALL=C: lpstat output is localized ("está inactiva" vs "is idle"), which breaks parsing.
    execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 5 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          const e = new Error((stderr || err.message || '').toString().trim() || 'Command failed');
          e.code = err.code;
          return reject(e);
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
      });
  });
}

// ─── Windows ────────────────────────────────────────────────────────────────

// Win32_Printer.PrinterStatus: 1 other, 2 unknown, 3 idle, 4 printing, 5 warmup, 6 stopped, 7 offline
const WIN_STATUS = { 1: 'other', 2: 'unknown', 3: 'idle', 4: 'printing', 5: 'warmup', 6: 'stopped', 7: 'offline' };

const WIN_RAW_SCRIPT = `
param([Parameter(Mandatory=$true)][string]$Printer, [Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RondappRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", EntryPoint = "OpenPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", EntryPoint = "StartDocPrinterW", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr h, IntPtr buf, int count, out int written);

  public static void Send(string printer, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("No se pudo abrir la impresora '" + printer + "' (error " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "RondApp";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, di)) throw new Exception("StartDocPrinter fallo (error " + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter fallo (error " + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(h, p, bytes.Length, out written) || written != bytes.Length)
            throw new Exception("WritePrinter fallo (error " + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
try {
  [RondappRawPrinter]::Send($Printer, [System.IO.File]::ReadAllBytes($File))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

let winScriptPath = null;
function ensureWinScript(dir) {
  if (winScriptPath && fs.existsSync(winScriptPath)) return winScriptPath;
  fs.mkdirSync(dir, { recursive: true });
  winScriptPath = path.join(dir, 'raw-print.ps1');
  // Windows PowerShell 5.1 reads BOM-less files as ANSI; the script is pure ASCII so this is safe.
  fs.writeFileSync(winScriptPath, WIN_RAW_SCRIPT, 'utf8');
  return winScriptPath;
}

async function getPrintersWin() {
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_Printer | Select-Object Name,Default,WorkOffline,PrinterStatus | ConvertTo-Json -Compress';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd]);
  const text = stdout.trim();
  if (!text) return [];
  let data = JSON.parse(text);
  if (!Array.isArray(data)) data = [data]; // single printer => object, not array
  return data.map((p) => ({
    name: p.Name,
    isDefault: !!p.Default,
    status: p.WorkOffline ? 'offline' : (WIN_STATUS[p.PrinterStatus] || 'unknown'),
  }));
}

async function printRawWin(printerName, buffer, workDir) {
  const script = ensureWinScript(workDir);
  const tmp = path.join(os.tmpdir(), `rondapp-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  fs.writeFileSync(tmp, buffer);
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', printerName, '-File', tmp]);
    return `win-${Date.now()}`;
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ─── macOS / Linux (CUPS) ───────────────────────────────────────────────────

// CUPS tools print localized text on macOS (it follows the system language, LC_ALL is ignored),
// so nothing below depends on translated words: we rely on `lpstat -e` (names only),
// the text after the last ':' of `lpstat -d`, and the numeric `printer-state` of `lpoptions`.
const CUPS_STATE = { 3: 'idle', 4: 'printing', 5: 'stopped' };

async function listPrinterNamesUnix() {
  const { stdout } = await run('lpstat', ['-e']);
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

async function getPrintersUnix() {
  let names = [];
  try {
    names = await listPrinterNamesUnix();
  } catch (err) {
    logger.warn('lpstat -e failed:', err.message);
    return [];
  }
  let def = null;
  try {
    const { stdout } = await run('lpstat', ['-d']);
    const m = stdout.match(/:\s*(\S+)\s*$/); // "system default destination: NAME" in any language
    if (m) def = m[1];
  } catch (_) { /* no default printer */ }

  return Promise.all(names.map(async (name) => {
    let status = 'unknown';
    try {
      const { stdout } = await run('lpoptions', ['-p', name]);
      const m = stdout.match(/printer-state=(\d+)/);
      if (m) status = CUPS_STATE[m[1]] || 'unknown';
    } catch (_) { /* ignore */ }
    return { name, isDefault: name === def, status };
  }));
}

async function printRawUnix(printerName, buffer) {
  let known = [];
  try { known = await listPrinterNamesUnix(); } catch (_) { /* let lp report the problem */ }
  if (known.length && !known.includes(printerName)) {
    throw new Error(`La impresora "${printerName}" no existe en este equipo`);
  }

  const tmp = path.join(os.tmpdir(), `rondapp-job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);
  fs.writeFileSync(tmp, buffer);
  try {
    const { stdout } = await run('lp', ['-d', printerName, '-o', 'raw', tmp]);
    const m = stdout.match(/(\S+-\d+)\s*\(/); // "request id is NAME-123 (1 file(s))" in any language
    return m ? m[1] : `lp-${Date.now()}`;
  } finally {
    fs.unlink(tmp, () => {});
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Returns [{ name, isDefault, status }] of printers installed in the OS. Never throws. */
async function getPrinters() {
  try {
    return IS_WIN ? await getPrintersWin() : await getPrintersUnix();
  } catch (err) {
    logger.error('Error listing printers:', err);
    return [];
  }
}

/**
 * Sends raw bytes (ESC/POS) straight to the spooler.
 * @param {string} printerName
 * @param {Buffer} buffer
 * @param {string} workDir writable dir (used on Windows to store the helper script)
 * @returns {Promise<string>} job id
 */
function printDirect(printerName, buffer, workDir) {
  return IS_WIN ? printRawWin(printerName, buffer, workDir) : printRawUnix(printerName, buffer);
}

module.exports = { getPrinters, printDirect };
