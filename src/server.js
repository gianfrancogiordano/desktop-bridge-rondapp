const http = require('http');
const WebSocket = require('ws');
const logger = require('./logger');
const { getPrinters, printDirect } = require('./printer');

const PORT = 17842;
// Chrome resolves `localhost` to ::1 first and falls back to 127.0.0.1. We listen on BOTH loopbacks so an
// old bridge bound to only one family can never silently shadow this one (and EADDRINUSE is detected).
const HOSTS = ['127.0.0.1', '::1'];

// Browsers always send an Origin header on WebSocket handshakes. A random website must not be
// able to print on the user's machine, so only the RondApp extension / app origins are allowed.
// Connections without Origin (wscat, local tools) are allowed: they are not web pages.
const ALLOWED_ORIGINS = [
  'chrome-extension://',
  'moz-extension://',
  'https://app.rondappve.com',
  'http://localhost:4200',
];

function isOriginAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

/**
 * Starts the local WebSocket server.
 * @param {{ version: string, workDir: string, onPrint?: (info) => void, onClients?: (n: number) => void }} opts
 * @returns {Promise<{ close: () => Promise<void> }>} resolves once listening; rejects on listen error (e.g. EADDRINUSE)
 */
function startServer({ version, workDir, onPrint, onClients }) {
  return new Promise((resolve, reject) => {
    const handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ service: 'Rondapp PrintBridge', status: 'running', version }));
    };

    const wss = new WebSocket.Server({
      noServer: true,
      verifyClient: (info, done) => {
        const ok = isOriginAllowed(info.origin);
        if (!ok) logger.warn('Rejected WS connection from origin:', info.origin);
        done(ok, 403, 'Forbidden origin');
      },
    });

    wss.on('connection', (ws) => {
      onClients && onClients(wss.clients.size);

      ws.on('message', async (message) => {
        let payload;
        try {
          payload = JSON.parse(message);
        } catch (err) {
          logger.error('Invalid WS message:', err.message);
          return;
        }

        const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
        // The extension sends the job id as `id`; older clients used `jobId`.
        const jobId = payload.jobId || payload.id;

        try {
          if (payload.type === 'PING') {
            send({ type: 'PONG', version });
          } else if (payload.type === 'LIST_PRINTERS') {
            send({ type: 'PRINTERS', list: await getPrinters() });
          } else if (payload.type === 'PRINT') {
            const printData = payload.data || payload.bytes;
            if (!payload.printerName || !printData) {
              send({ type: 'PRINT_ERROR', error: 'Missing printerName or data', jobId, id: jobId });
              return;
            }
            try {
              const result = await printDirect(payload.printerName, Buffer.from(printData), workDir);
              logger.info(`PRINT ok -> "${payload.printerName}" (${printData.length} bytes) job=${result}`);
              onPrint && onPrint({ ok: true, printer: payload.printerName });
              send({ type: 'PRINT_OK', jobId, id: jobId, result });
            } catch (printErr) {
              logger.error(`PRINT failed -> "${payload.printerName}":`, printErr);
              onPrint && onPrint({ ok: false, printer: payload.printerName, error: printErr.message });
              send({ type: 'PRINT_ERROR', error: printErr.message || String(printErr), jobId, id: jobId });
            }
          }
        } catch (err) {
          logger.error('Error handling message:', err);
          send({ type: 'PRINT_ERROR', error: err.message || String(err), jobId, id: jobId });
        }
      });

      ws.on('close', () => onClients && onClients(wss.clients.size));
      ws.on('error', (err) => logger.warn('WS client error:', err.message));
    });

    const servers = [];
    const closeAll = () => new Promise((r) => {
      wss.clients.forEach((c) => c.terminate());
      let pending = servers.length;
      if (!pending) return r();
      servers.forEach((s) => s.close(() => { if (--pending === 0) r(); }));
    });

    const listenOn = (host) => new Promise((res, rej) => {
      const s = http.createServer(handler);
      s.on('upgrade', (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
      s.once('error', rej);
      s.listen(PORT, host, () => {
        s.removeListener('error', rej);
        s.on('error', (e) => logger.error(`Server error (${host}):`, e));
        servers.push(s);
        res();
      });
    }).then(() => true, (err) => {
      // IPv6 may be disabled on the machine: that is fine. Anything else (port busy...) is fatal.
      if (host === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EINVAL'].includes(err.code)) {
        logger.warn('IPv6 loopback not available, skipping:', err.code);
        return false;
      }
      throw err;
    });

    (async () => {
      for (const host of HOSTS) await listenOn(host);
      logger.info(`Server listening on ws://localhost:${PORT} (${servers.length} loopback address(es))`);
      resolve({ close: closeAll });
    })().catch(async (err) => {
      await closeAll(); // release the sockets that did bind before failing
      reject(err);
    });
  });
}

module.exports = { startServer, PORT };
