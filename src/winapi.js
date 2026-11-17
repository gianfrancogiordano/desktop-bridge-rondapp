/**
 * Windows API through koffi (FFI with prebuilt binaries, no node-gyp): fallback for PCs without PowerShell
 * (stripped Windows builds, or an antivirus that blocks it). Same four jobs as the PowerShell path:
 *
 *  - list printers        → winspool EnumPrintersW (level 2) + GetDefaultPrinterW
 *  - RAW printing         → winspool OpenPrinterW / StartDocPrinterW / WritePrinter
 *  - list COM ports       → setupapi (class Ports, present devices): friendly name + device instance id,
 *                           the same Name / PNPDeviceID that Win32_PnPEntity gives, so ports.toPorts() is reused
 *  - fiscal serial port   → kernel32 CreateFileW + SetCommState (HKA: 9600 8E1, RTS/CTS) + ReadFile/WriteFile
 *
 * koffi keeps the thread's GetLastError() value between calls, so it can be read right after a failed call.
 */
const logger = require('./logger');

// ─── Pure helpers (testable on any OS) ──────────────────────────────────────

// winspool PRINTER_STATUS_* / PRINTER_ATTRIBUTE_* bits
const PRINTER_STATUS_PAUSED = 0x1;
const PRINTER_STATUS_ERROR = 0x2;
const PRINTER_STATUS_OFFLINE = 0x80;
const PRINTER_STATUS_PRINTING = 0x400;
const PRINTER_ATTRIBUTE_WORK_OFFLINE = 0x400;

/** Same vocabulary as the PowerShell path (Win32_Printer.PrinterStatus). */
function printerStatus(status, attributes) {
  if ((attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) || (status & PRINTER_STATUS_OFFLINE)) return 'offline';
  if (status === 0) return 'idle';
  if (status & PRINTER_STATUS_PRINTING) return 'printing';
  if (status & (PRINTER_STATUS_PAUSED | PRINTER_STATUS_ERROR)) return 'stopped';
  return 'unknown';
}

/**
 * DCB flag bits for the HKA, matching what System.IO.Ports did in the PowerShell transport
 * (Parity.Even, Handshake.RequestToSend, DtrEnable = false). Keeps the bits we do not care about.
 */
function hkaDcbFlags(flags) {
  let f = flags >>> 0;
  f |= 1 << 0; // fBinary
  f |= 1 << 1; // fParity
  f |= 1 << 2; // fOutxCtsFlow: wait for CTS before sending
  f &= ~(1 << 3); // fOutxDsrFlow
  f &= ~(3 << 4); // fDtrControl = DTR_CONTROL_DISABLE
  f &= ~(1 << 6); // fDsrSensitivity
  f &= ~(1 << 8); // fOutX
  f &= ~(1 << 9); // fInX
  f &= ~(1 << 10); // fErrorChar
  f &= ~(1 << 11); // fNull
  f = (f & ~(3 << 12)) | (2 << 12); // fRtsControl = RTS_CONTROL_HANDSHAKE
  f &= ~(1 << 14); // fAbortOnError
  return f >>> 0;
}

/** NUL-terminated UTF-16 in a Buffer → string */
function utf16z(buf) {
  const s = buf.toString('utf16le');
  const i = s.indexOf('\0');
  return i < 0 ? s : s.slice(0, i);
}

// ─── Bindings (loaded on first use, Windows only) ───────────────────────────

let koffi = null;
let T = null; // struct types
let api = null;

/** Struct types; defined without loading any DLL so their sizes can be checked on any OS. */
function types() {
  if (T) return T;
  koffi = koffi || require('koffi');
  T = {
    PRINTER_INFO_2W: koffi.struct('RONDAPP_PRINTER_INFO_2W', {
      pServerName: 'void *', pPrinterName: 'str16', pShareName: 'void *', pPortName: 'void *',
      pDriverName: 'void *', pComment: 'void *', pLocation: 'void *', pDevMode: 'void *',
      pSepFile: 'void *', pPrintProcessor: 'void *', pDatatype: 'void *', pParameters: 'void *',
      pSecurityDescriptor: 'void *',
      Attributes: 'uint32', Priority: 'uint32', DefaultPriority: 'uint32', StartTime: 'uint32',
      UntilTime: 'uint32', Status: 'uint32', cJobs: 'uint32', AveragePPM: 'uint32',
    }),
    DOC_INFO_1W: koffi.struct('RONDAPP_DOC_INFO_1W', { pDocName: 'str16', pOutputFile: 'str16', pDatatype: 'str16' }),
    GUID: koffi.struct('RONDAPP_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) }),
    DCB: koffi.struct('RONDAPP_DCB', {
      DCBlength: 'uint32', BaudRate: 'uint32', fFlags: 'uint32', wReserved: 'uint16', XonLim: 'uint16',
      XoffLim: 'uint16', ByteSize: 'uint8', Parity: 'uint8', StopBits: 'uint8', XonChar: 'int8', XoffChar: 'int8',
      ErrorChar: 'int8', EofChar: 'int8', EvtChar: 'int8', wReserved1: 'uint16',
    }),
    COMMTIMEOUTS: koffi.struct('RONDAPP_COMMTIMEOUTS', {
      ReadIntervalTimeout: 'uint32', ReadTotalTimeoutMultiplier: 'uint32', ReadTotalTimeoutConstant: 'uint32',
      WriteTotalTimeoutMultiplier: 'uint32', WriteTotalTimeoutConstant: 'uint32',
    }),
  };
  T.SP_DEVINFO_DATA = koffi.struct('RONDAPP_SP_DEVINFO_DATA', { cbSize: 'uint32', ClassGuid: T.GUID, DevInst: 'uint32', Reserved: 'uintptr' });
  return T;
}

function load() {
  if (api) return api;
  if (process.platform !== 'win32') throw new Error('La API de Windows solo está disponible en Windows');
  types();
  const winspool = koffi.load('winspool.drv');
  const kernel32 = koffi.load('kernel32.dll');
  const setupapi = koffi.load('setupapi.dll');
  api = {
    GetLastError: kernel32.func('uint32 __stdcall GetLastError()'),

    EnumPrintersW: winspool.func('bool __stdcall EnumPrintersW(uint32 flags, str16 name, uint32 level, void *buf, uint32 cbBuf, _Out_ uint32 *needed, _Out_ uint32 *returned)'),
    GetDefaultPrinterW: winspool.func('bool __stdcall GetDefaultPrinterW(void *buf, _Inout_ uint32 *size)'),
    OpenPrinterW: winspool.func('bool __stdcall OpenPrinterW(str16 name, _Out_ intptr *handle, void *defaults)'),
    ClosePrinter: winspool.func('bool __stdcall ClosePrinter(intptr h)'),
    StartDocPrinterW: winspool.func('uint32 __stdcall StartDocPrinterW(intptr h, uint32 level, RONDAPP_DOC_INFO_1W *di)'),
    EndDocPrinter: winspool.func('bool __stdcall EndDocPrinter(intptr h)'),
    StartPagePrinter: winspool.func('bool __stdcall StartPagePrinter(intptr h)'),
    EndPagePrinter: winspool.func('bool __stdcall EndPagePrinter(intptr h)'),
    WritePrinter: winspool.func('bool __stdcall WritePrinter(intptr h, void *buf, uint32 count, _Out_ uint32 *written)'),

    SetupDiGetClassDevsW: setupapi.func('intptr __stdcall SetupDiGetClassDevsW(RONDAPP_GUID *classGuid, void *enumerator, void *hwnd, uint32 flags)'),
    SetupDiEnumDeviceInfo: setupapi.func('bool __stdcall SetupDiEnumDeviceInfo(intptr set, uint32 index, _Inout_ RONDAPP_SP_DEVINFO_DATA *data)'),
    SetupDiGetDeviceInstanceIdW: setupapi.func('bool __stdcall SetupDiGetDeviceInstanceIdW(intptr set, RONDAPP_SP_DEVINFO_DATA *data, void *buf, uint32 size, _Out_ uint32 *required)'),
    SetupDiGetDeviceRegistryPropertyW: setupapi.func('bool __stdcall SetupDiGetDeviceRegistryPropertyW(intptr set, RONDAPP_SP_DEVINFO_DATA *data, uint32 prop, _Out_ uint32 *regType, void *buf, uint32 size, _Out_ uint32 *required)'),
    SetupDiDestroyDeviceInfoList: setupapi.func('bool __stdcall SetupDiDestroyDeviceInfoList(intptr set)'),

    CreateFileW: kernel32.func('intptr __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, intptr template)'),
    CloseHandle: kernel32.func('bool __stdcall CloseHandle(intptr h)'),
    GetCommState: kernel32.func('bool __stdcall GetCommState(intptr h, _Out_ RONDAPP_DCB *dcb)'),
    SetCommState: kernel32.func('bool __stdcall SetCommState(intptr h, RONDAPP_DCB *dcb)'),
    SetCommTimeouts: kernel32.func('bool __stdcall SetCommTimeouts(intptr h, RONDAPP_COMMTIMEOUTS *timeouts)'),
    SetupComm: kernel32.func('bool __stdcall SetupComm(intptr h, uint32 inQueue, uint32 outQueue)'),
    PurgeComm: kernel32.func('bool __stdcall PurgeComm(intptr h, uint32 flags)'),
    ReadFile: kernel32.func('bool __stdcall ReadFile(intptr h, void *buf, uint32 toRead, _Out_ uint32 *read, void *overlapped)'),
    WriteFile: kernel32.func('bool __stdcall WriteFile(intptr h, void *buf, uint32 toWrite, _Out_ uint32 *written, void *overlapped)'),
  };
  return api;
}

const lastError = () => api.GetLastError();

// ─── Printers ───────────────────────────────────────────────────────────────

const PRINTER_ENUM_LOCAL = 0x2;
const PRINTER_ENUM_CONNECTIONS = 0x4;

function defaultPrinterName() {
  const a = load();
  const size = [0];
  a.GetDefaultPrinterW(null, size); // ERROR_INSUFFICIENT_BUFFER, size = chars incl. NUL (0 = no default printer)
  if (!size[0]) return null;
  const buf = Buffer.alloc(size[0] * 2);
  return a.GetDefaultPrinterW(buf, [size[0]]) ? utf16z(buf) : null;
}

/** [{ name, isDefault, status }] — same shape as the PowerShell path. */
function listPrinters() {
  const a = load();
  const flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  const needed = [0];
  const returned = [0];
  a.EnumPrintersW(flags, null, 2, null, 0, needed, returned);
  if (!needed[0]) return [];
  const buf = Buffer.alloc(needed[0]);
  if (!a.EnumPrintersW(flags, null, 2, buf, buf.length, needed, returned)) {
    throw new Error(`EnumPrinters falló (error ${lastError()})`);
  }
  const def = defaultPrinterName();
  const size = koffi.sizeof(T.PRINTER_INFO_2W);
  const list = [];
  for (let i = 0; i < returned[0]; i++) {
    const p = koffi.decode(buf, i * size, T.PRINTER_INFO_2W); // its strings point inside buf, still alive here
    list.push({ name: p.pPrinterName, isDefault: p.pPrinterName === def, status: printerStatus(p.Status, p.Attributes) });
  }
  return list;
}

/** Sends raw bytes (ESC/POS) to the spooler. Returns a job id. */
function printRaw(printerName, buffer) {
  const a = load();
  const h = [0];
  if (!a.OpenPrinterW(printerName, h, null)) {
    throw new Error(`No se pudo abrir la impresora '${printerName}' (error ${lastError()})`);
  }
  try {
    const job = a.StartDocPrinterW(h[0], 1, { pDocName: 'RondApp', pOutputFile: null, pDatatype: 'RAW' });
    if (!job) throw new Error(`StartDocPrinter falló (error ${lastError()})`);
    try {
      if (!a.StartPagePrinter(h[0])) throw new Error(`StartPagePrinter falló (error ${lastError()})`);
      const data = Buffer.from(buffer);
      const written = [0];
      if (!a.WritePrinter(h[0], data, data.length, written) || written[0] !== data.length) {
        throw new Error(`WritePrinter falló (error ${lastError()})`);
      }
      a.EndPagePrinter(h[0]);
    } finally { a.EndDocPrinter(h[0]); }
    return `win-${job}`;
  } finally { a.ClosePrinter(h[0]); }
}

// ─── COM ports ──────────────────────────────────────────────────────────────

// GUID_DEVCLASS_PORTS {4D36E978-E325-11CE-BFC1-08002BE10318}
const GUID_DEVCLASS_PORTS = { Data1: 0x4D36E978, Data2: 0xE325, Data3: 0x11CE, Data4: [0xBF, 0xC1, 0x08, 0x00, 0x2B, 0xE1, 0x03, 0x18] };
const DIGCF_PRESENT = 0x2;
const SPDRP_FRIENDLYNAME = 0x0C;
const INVALID_HANDLE = -1;

/** Present devices of class Ports as Win32_PnPEntity-like rows: [{ Name, PNPDeviceID }] (LPT included; toPorts filters). */
function listPortRows() {
  const a = load();
  const set = a.SetupDiGetClassDevsW(GUID_DEVCLASS_PORTS, null, null, DIGCF_PRESENT);
  if (set === INVALID_HANDLE || !set) throw new Error(`SetupDiGetClassDevs falló (error ${lastError()})`);
  const rows = [];
  try {
    const buf = Buffer.alloc(1024);
    for (let i = 0; ; i++) {
      const dev = { cbSize: koffi.sizeof(T.SP_DEVINFO_DATA), ClassGuid: GUID_DEVCLASS_PORTS, DevInst: 0, Reserved: 0 };
      if (!a.SetupDiEnumDeviceInfo(set, i, dev)) break; // ERROR_NO_MORE_ITEMS
      buf.fill(0);
      const id = a.SetupDiGetDeviceInstanceIdW(set, dev, buf, buf.length / 2, [0]) ? utf16z(buf) : '';
      buf.fill(0);
      const name = a.SetupDiGetDeviceRegistryPropertyW(set, dev, SPDRP_FRIENDLYNAME, [0], buf, buf.length, [0]) ? utf16z(buf) : '';
      if (name) rows.push({ Name: name, PNPDeviceID: id });
    }
  } finally { a.SetupDiDestroyDeviceInfoList(set); }
  return rows;
}

// ─── Serial transport (fiscal) ──────────────────────────────────────────────

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const OPEN_EXISTING = 3;
const EVENPARITY = 2;
const ONESTOPBIT = 0;
const PURGE_ALL = 0x1 | 0x2 | 0x4 | 0x8; // TXABORT | RXABORT | TXCLEAR | RXCLEAR
const MAXDWORD = 0xFFFFFFFF;
const WRITE_TIMEOUT_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function openError(port, code) {
  if (code === 2 || code === 3) return `El puerto ${port} no existe`;
  if (code === 5) return `El puerto ${port} está ocupado por otro programa (acceso denegado)`;
  return `No se pudo abrir ${port} (error ${code})`;
}

/**
 * Same contract as ./fiscal/transport.js and the PowerShell transport. Reads never block: with
 * ReadIntervalTimeout = MAXDWORD ReadFile returns at once with whatever arrived. Writes block until the
 * printer raises CTS (or 3 s), so they run off the main thread (koffi async).
 */
class NativeSerialTransport {
  static async open(port, { baud = 9600 } = {}) {
    if (!/^COM\d+$/i.test(port)) throw new Error(`Puerto inválido: ${port}`);
    const a = load();
    const h = a.CreateFileW(`\\\\.\\${port.toUpperCase()}`, (GENERIC_READ | GENERIC_WRITE) >>> 0, 0, null, OPEN_EXISTING, 0, 0);
    if (h === INVALID_HANDLE) throw new Error(openError(port, lastError()));
    try {
      a.SetupComm(h, 4096, 4096);
      const dcb = {};
      if (!a.GetCommState(h, dcb)) throw new Error(`GetCommState falló (error ${lastError()})`);
      Object.assign(dcb, {
        DCBlength: koffi.sizeof(T.DCB), BaudRate: baud, fFlags: hkaDcbFlags(dcb.fFlags),
        ByteSize: 8, Parity: EVENPARITY, StopBits: ONESTOPBIT,
      });
      if (!a.SetCommState(h, dcb)) throw new Error(`No se pudo configurar ${port} (error ${lastError()})`);
      const timeouts = {
        ReadIntervalTimeout: MAXDWORD, ReadTotalTimeoutMultiplier: 0, ReadTotalTimeoutConstant: 0,
        WriteTotalTimeoutMultiplier: 0, WriteTotalTimeoutConstant: WRITE_TIMEOUT_MS,
      };
      if (!a.SetCommTimeouts(h, timeouts)) throw new Error(`SetCommTimeouts falló (error ${lastError()})`);
      a.PurgeComm(h, PURGE_ALL);
    } catch (err) {
      a.CloseHandle(h);
      throw err;
    }
    const t = new NativeSerialTransport();
    t.h = h;
    t.port = port;
    t.buf = Buffer.alloc(4096);
    return t;
  }

  _readNow() {
    const n = [0];
    if (!api.ReadFile(this.h, this.buf, this.buf.length, n, null)) throw new Error(`Error leyendo ${this.port} (error ${lastError()})`);
    return n[0] ? Buffer.from(this.buf.subarray(0, n[0])) : null;
  }

  write(bytes) {
    if (this.closed) return Promise.reject(new Error('El puerto está cerrado'));
    const data = Buffer.from(bytes);
    const written = [0];
    return new Promise((resolve, reject) => {
      api.WriteFile.async(this.h, data, data.length, written, null, (err, ok) => {
        if (err) return reject(err);
        // A short write means the write timeout expired: with RTS/CTS the printer never raised CTS
        if (ok && written[0] === data.length) return resolve();
        reject(new Error('La impresora fiscal no está lista (sin CTS): ¿está encendida y conectada?'));
      });
    });
  }

  /** Same loop as the PowerShell script: wait for data, then stop once 30 ms pass without more bytes. */
  async read(timeoutMs) {
    if (this.closed) throw new Error('El puerto está cerrado');
    const chunks = [];
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const chunk = this._readNow();
      if (chunk) {
        chunks.push(chunk);
        await sleep(30);
        const more = this._readNow();
        if (!more) break;
        chunks.push(more);
      } else {
        await sleep(10);
      }
    }
    return Buffer.concat(chunks);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { api.CloseHandle(this.h); } catch (err) { logger.warn('[fiscal] CloseHandle:', err.message); }
  }
}

module.exports = { listPrinters, printRaw, listPortRows, NativeSerialTransport, printerStatus, hkaDcbFlags, types };
