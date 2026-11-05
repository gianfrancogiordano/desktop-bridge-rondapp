/**
 * Serial ports (COM) on Windows, with the USB VID/PID so the HKA can be autodetected: the HKA-80 shows up
 * as a USB CDC virtual COM port VID_04D8&PID_000A (dato de terceros; validar con la máquina real).
 */
const { execFile } = require('child_process');

const HKA_USB_IDS = [{ vid: '04D8', pid: '000A' }];

/** "USB\\VID_04D8&PID_000A\\5&2A…" → { vid: '04D8', pid: '000A' } */
function usbIds(pnpId) {
  const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(pnpId || '');
  return m ? { vid: m[1].toUpperCase(), pid: m[2].toUpperCase() } : { vid: null, pid: null };
}

/** Win32_PnPEntity rows → ports, HKA candidates first. */
function toPorts(rows) {
  return (rows || [])
    .map((r) => {
      const m = /\((COM\d+)\)/i.exec(r.Name || '');
      if (!m) return null;
      const { vid, pid } = usbIds(r.PNPDeviceID);
      return {
        port: m[1].toUpperCase(),
        name: r.Name,
        vid,
        pid,
        likelyHka: HKA_USB_IDS.some((h) => h.vid === vid && h.pid === pid),
      };
    })
    .filter(Boolean)
    .sort((a, b) => Number(b.likelyHka) - Number(a.likelyHka) || a.port.localeCompare(b.port, undefined, { numeric: true }));
}

function listSerialPorts() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  const cmd = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | Select-Object Name,PNPDeviceID | ConvertTo-Json -Compress";
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(err);
        const text = String(stdout).trim();
        if (!text) return resolve([]);
        let rows = JSON.parse(text);
        if (!Array.isArray(rows)) rows = [rows];
        resolve(toPorts(rows));
      });
  });
}

module.exports = { listSerialPorts, toPorts, usbIds, HKA_USB_IDS };
