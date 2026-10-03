const { app, Tray, Menu, nativeImage, Notification, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getPrinters, printDirect } = require('./printer');
const { startServer, PORT } = require('./server');
const { cleanupLegacyBridge } = require('./legacy');

const PRINTER_REFRESH_MS = 30000;
const SERVER_RETRY_MS = 10000;

let tray = null;
let server = null;
let retryTimer = null;
let printers = [];
let clients = 0;
let lastJob = null;
const state = { server: 'starting', error: '' }; // server: starting | running | error

// ── Single instance ─────────────────────────────────────────────────────────
// A second launch (e.g. user double-clicks the shortcut again) must not fight for the port.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── Config (userData/config.json) ───────────────────────────────────────────
function configPath() { return path.join(app.getPath('userData'), 'config.json'); }

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (err) { logger.warn('Could not save config:', err.message); }
}

function isAutoStart() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoStart(enabled) {
  // In dev (`electron .`) execPath is Electron itself: registering it would be wrong.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  const cfg = loadConfig();
  cfg.autoStartChoice = enabled;
  saveConfig(cfg);
}

// ── ESC/POS test ticket ─────────────────────────────────────────────────────
function buildTestBytes(printerName) {
  const b = [];
  const text = (t) => { for (const ch of t) b.push(ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0x3f); b.push(0x0a); };
  const safe = String(printerName).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  b.push(0x1b, 0x40);            // init
  b.push(0x1b, 0x61, 1);         // center
  b.push(0x1b, 0x45, 1);         // bold
  b.push(0x1d, 0x21, 0x11);      // double size
  text('PRUEBA RONDAPP');
  b.push(0x1d, 0x21, 0x00, 0x1b, 0x45, 0);
  text('--------------------------------');
  text(safe);
  text('PrintBridge v' + app.getVersion());
  text('Impresora OK');
  text('--------------------------------');
  b.push(0x0a, 0x0a, 0x0a, 0x0a, 0x0a);
  b.push(0x1d, 0x56, 0x42, 0x00); // feed & partial cut
  return Buffer.from(b);
}

async function testPrint(name) {
  try {
    await printDirect(name, buildTestBytes(name), app.getPath('userData'));
    lastJob = { ok: true, printer: name, at: new Date() };
    notify('Prueba enviada', `Se envió la página de prueba a "${name}".`);
  } catch (err) {
    lastJob = { ok: false, printer: name, error: err.message, at: new Date() };
    logger.error('Test print failed:', err);
    notify('No se pudo imprimir', err.message);
  }
  refreshMenu();
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title: `RondApp PrintBridge — ${title}`, body }).show(); } catch (_) { /* ignore */ }
}

// ── Tray menu ───────────────────────────────────────────────────────────────
function statusLabel() {
  if (state.server === 'running') return `● Servidor activo (puerto ${PORT})`;
  if (state.server === 'starting') return '○ Iniciando servidor…';
  return `✕ Error: ${state.error}`;
}

function buildMenu() {
  const printerItems = printers.length
    ? printers.map((p) => ({ label: p.name + (p.isDefault ? ' (predeterminada)' : ''), enabled: false }))
    : [{ label: 'No se detectaron impresoras', enabled: false }];

  const testItems = printers.length
    ? printers.map((p) => ({ label: p.name, click: () => testPrint(p.name) }))
    : [{ label: 'No hay impresoras', enabled: false }];

  const jobLabel = !lastJob ? 'Sin trabajos recientes'
    : lastJob.ok ? `Último trabajo: OK → ${lastJob.printer}`
      : `Último trabajo: ERROR → ${lastJob.printer}`;

  return Menu.buildFromTemplate([
    { label: `RondApp PrintBridge v${app.getVersion()}`, enabled: false },
    { label: statusLabel(), enabled: false },
    { label: clients > 0 ? `Extensión conectada (${clients})` : 'Esperando conexión de la extensión', enabled: false },
    { type: 'separator' },
    { label: `Impresoras (${printers.length})`, submenu: printerItems },
    { label: 'Imprimir página de prueba', submenu: testItems },
    { label: 'Actualizar impresoras', click: () => refreshPrinters() },
    { label: jobLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Iniciar con el sistema',
      type: 'checkbox',
      checked: isAutoStart(),
      enabled: app.isPackaged,
      click: (item) => setAutoStart(item.checked),
    },
    { label: 'Abrir carpeta de logs', click: () => shell.openPath(logger.getDir()) },
    { type: 'separator' },
    { label: 'Salir', click: () => quit() },
  ]);
}

function refreshMenu() {
  if (!tray) return;
  tray.setContextMenu(buildMenu());
  tray.setToolTip(`RondApp PrintBridge — ${state.server === 'running' ? 'Activo' : state.server === 'starting' ? 'Iniciando…' : 'Error'}`);
}

async function refreshPrinters() {
  printers = await getPrinters();
  refreshMenu();
}

// ── Server lifecycle ────────────────────────────────────────────────────────
async function listen() {
  state.server = 'starting';
  refreshMenu();
  return startServer({
    version: app.getVersion(),
    workDir: app.getPath('userData'),
    onPrint: (info) => { lastJob = { ...info, at: new Date() }; refreshMenu(); },
    onClients: (n) => { clients = n; refreshMenu(); },
  });
}

async function startBridge() {
  clearTimeout(retryTimer);
  try {
    try {
      server = await listen();
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      // Most likely the old pkg-based bridge (v1.x) is still alive.
      logger.warn(`Port ${PORT} busy, trying to clean up the legacy bridge…`);
      await cleanupLegacyBridge();
      await new Promise((r) => setTimeout(r, 1000));
      server = await listen();
    }
    state.server = 'running';
    state.error = '';
  } catch (err) {
    state.server = 'error';
    state.error = err.code === 'EADDRINUSE' ? `puerto ${PORT} ocupado por otra aplicación` : err.message;
    logger.error('Could not start server:', err);
    notify('Error', state.error);
    retryTimer = setTimeout(startBridge, SERVER_RETRY_MS);
  }
  refreshMenu();
}

async function quit() {
  clearTimeout(retryTimer);
  try { if (server) await server.close(); } catch (_) { /* ignore */ }
  app.exit(0);
}

// ── App lifecycle ───────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => logger.error('uncaughtException:', err));
process.on('unhandledRejection', (err) => logger.error('unhandledRejection:', err));

// No windows: keep running in the tray when nothing is open.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  logger.init(app.getPath('logs'));
  logger.info(`Starting PrintBridge v${app.getVersion()} (${process.platform}/${process.arch}, packaged=${app.isPackaged})`);

  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon48.png'))
    .resize({ width: process.platform === 'darwin' ? 18 : 16, height: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(icon);
  tray.on('click', () => tray.popUpContextMenu());
  refreshMenu();

  // First run: enable auto-start by default (user can turn it off from the menu).
  const cfg = loadConfig();
  if (cfg.autoStartChoice === undefined) setAutoStart(true);

  await startBridge();
  await refreshPrinters();
  setInterval(refreshPrinters, PRINTER_REFRESH_MS);
});
