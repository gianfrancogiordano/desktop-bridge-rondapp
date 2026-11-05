/**
 * Real COM-port transport on Windows WITHOUT native addons (same approach as ../printer.js).
 *
 * A long-lived PowerShell process opens the port with System.IO.Ports (HKA: 9600 bps, 8 bits, even parity,
 * 1 stop bit, RTS/CTS handshake) and acts as a dumb byte pipe. Node drives it with one line per request:
 *   W <hex>   → write bytes            ← OK | ERR <msg>
 *   R <ms>    → read what arrives       ← D <hex>   (empty hex = nothing arrived: silence is information)
 *   Q         → close the port and exit
 * The process answers READY (or ERR <msg>) once the port is open. All protocol logic stays in JS.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const logger = require('../logger');

const SCRIPT = `
param([Parameter(Mandatory=$true)][string]$Port, [int]$Baud = 9600)
$ErrorActionPreference = 'Stop'
$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, ([System.IO.Ports.Parity]::Even), 8, ([System.IO.Ports.StopBits]::One)
$sp.Handshake = [System.IO.Ports.Handshake]::RequestToSend
$sp.ReadTimeout = 50
$sp.WriteTimeout = 3000
try { $sp.Open() } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message); [Console]::Out.Flush(); exit 1 }
[Console]::Out.WriteLine('READY'); [Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq 'Q') { break }
  try {
    if ($line.StartsWith('W ')) {
      $hex = $line.Substring(2)
      $bytes = New-Object byte[] ($hex.Length / 2)
      for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
      $sp.Write($bytes, 0, $bytes.Length)
      [Console]::Out.WriteLine('OK')
    } elseif ($line.StartsWith('R ')) {
      $timeout = [int]$line.Substring(2)
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $sb = New-Object System.Text.StringBuilder
      while ($sw.ElapsedMilliseconds -lt $timeout) {
        if ($sp.BytesToRead -gt 0) {
          $n = $sp.BytesToRead
          $tmp = New-Object byte[] $n
          $r = $sp.Read($tmp, 0, $n)
          for ($i = 0; $i -lt $r; $i++) { [void]$sb.Append($tmp[$i].ToString('X2')) }
          Start-Sleep -Milliseconds 30
          if ($sp.BytesToRead -eq 0) { break }
        } else { Start-Sleep -Milliseconds 10 }
      }
      [Console]::Out.WriteLine('D ' + $sb.ToString())
    } else {
      [Console]::Out.WriteLine('ERR unknown request')
    }
  } catch { [Console]::Out.WriteLine('ERR ' + $_.Exception.Message) }
  [Console]::Out.Flush()
}
$sp.Close()
`;

let scriptPath = null;
function ensureScript(dir) {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  fs.mkdirSync(dir, { recursive: true });
  scriptPath = path.join(dir, 'fiscal-serial.ps1');
  fs.writeFileSync(scriptPath, SCRIPT, 'utf8'); // pure ASCII: safe for Windows PowerShell 5.1
  return scriptPath;
}

class PowerShellSerialTransport {
  /** Opens `port` (e.g. "COM3"). Resolves once the port is open; rejects with the Windows error otherwise. */
  static async open(port, workDir, { baud = 9600, openTimeoutMs = 10000 } = {}) {
    if (process.platform !== 'win32') throw new Error('La impresora fiscal por ahora solo funciona en Windows');
    if (!/^COM\d+$/i.test(port)) throw new Error(`Puerto inválido: ${port}`);
    const t = new PowerShellSerialTransport();
    await t._start(ensureScript(workDir), port, baud, openTimeoutMs);
    return t;
  }

  _start(script, port, baud, openTimeoutMs) {
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', port, '-Baud', String(baud)], { windowsHide: true });
    this.lines = readline.createInterface({ input: this.proc.stdout });
    this.waiting = []; // resolvers of pending requests, FIFO (one line answers one request)
    this.lines.on('line', (line) => {
      const w = this.waiting.shift();
      if (w) w(line.trim());
    });
    this.proc.stderr.on('data', (d) => logger.warn('[fiscal] powershell:', d.toString().trim()));
    this.proc.on('exit', (code) => {
      this.closed = true;
      for (const w of this.waiting.splice(0)) w(`ERR El puerto se cerró (código ${code})`);
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No se pudo abrir ${port} a tiempo`)), openTimeoutMs);
      this.waiting.push((line) => {
        clearTimeout(timer);
        if (line === 'READY') resolve();
        else { this.close(); reject(new Error(line.replace(/^ERR\s*/, '') || `No se pudo abrir ${port}`)); }
      });
    });
  }

  _request(line) {
    if (this.closed) return Promise.reject(new Error('El puerto está cerrado'));
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.proc.stdin.write(line + '\n');
    });
  }

  async write(bytes) {
    const res = await this._request('W ' + Buffer.from(bytes).toString('hex').toUpperCase());
    if (res !== 'OK') {
      const msg = res.replace(/^ERR\s*/, '');
      // With RTS/CTS a write blocks until the printer raises CTS: a timeout means it is off or not ready
      throw new Error(/timed? ?out|tiempo/i.test(msg) ? 'La impresora fiscal no está lista (sin CTS): ¿está encendida y conectada?' : msg);
    }
  }

  async read(timeoutMs) {
    const res = await this._request('R ' + Math.max(1, Math.round(timeoutMs)));
    if (!res.startsWith('D')) throw new Error(res.replace(/^ERR\s*/, ''));
    const hex = res.slice(1).trim();
    return Buffer.from(hex, 'hex');
  }

  async close() {
    if (this.closed || !this.proc) return;
    this.closed = true;
    try { this.proc.stdin.write('Q\n'); } catch (e) { /* already gone */ }
    setTimeout(() => { try { this.proc.kill(); } catch (e) { /* ignore */ } }, 1000);
  }
}

module.exports = { PowerShellSerialTransport };
