const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { getPrinters, printDirect } = require('./printer');

const PORT = 17842;

function setupWindowsSilentMode() {
  if (process.platform !== 'win32') return false;
  if (!process.pkg) return false;

  const isSilent = process.argv.includes('--silent');
  const exePath = process.execPath;
  const startupPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupPath, 'rondapp-bridge.vbs');
  
  // 1. Install or update VBS in Startup folder for future reboots
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run chr(34) & "${exePath}" & Chr(34) & " --silent", 0\nSet WshShell = Nothing`;
  try {
    if (fs.existsSync(startupPath)) {
      fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    }
  } catch (err) {}

  // 2. If user double-clicked manually (visible console)
  if (!isSilent) {
    console.log('====================================================');
    console.log('  RONDAPP PRINT BRIDGE (WINDOWS)                    ');
    console.log('====================================================');
    console.log('');
    console.log('✅ Configurado para iniciar automaticamente con Windows.');
    console.log('✅ Pasando a modo oculto (segundo plano)...');
    console.log('');
    console.log('Esta ventana se cerrara sola en 3 segundos, pero el');
    console.log('puente de impresion SEGUIRA FUNCIONANDO invisible.');
    console.log('====================================================');

    try {
      const child = spawn(exePath, ['--silent'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch (e) {
      console.log('Error launching background process:', e.message);
    }

    setTimeout(() => {
      process.exit(0);
    }, 4000);
    return true; // Stop here for visible process
  }

  // 3. We are in silent mode. Add a safety net for crashes.
  process.on('uncaughtException', (err) => {
    try {
      fs.writeFileSync(path.join(os.homedir(), 'Desktop', 'rondapp-bridge-error.log'), err.stack || err.message);
    } catch(e) {}
  });

  return false; // Proceed normally for hidden process
}

if (setupWindowsSilentMode()) {
  return;
}

// Create HTTP server to handle both WS and HTTP (optional for future REST fallback)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ service: 'Rondapp PrintBridge', status: 'running', version: '2.0.0' }));
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');

  ws.on('message', async (message) => {
    try {
      const payload = JSON.parse(message);
      
      if (payload.type === 'PING') {
        ws.send(JSON.stringify({ type: 'PONG', version: '2.0.0' }));
      }
      
      else if (payload.type === 'LIST_PRINTERS') {
        const printers = getPrinters();
        ws.send(JSON.stringify({ type: 'PRINTERS', list: printers }));
      }
      
      else if (payload.type === 'PRINT') {
        const { printerName, data, bytes } = payload;
        const printData = data || bytes;
        
        if (!printerName || !printData) {
          ws.send(JSON.stringify({ type: 'PRINT_ERROR', error: 'Missing printerName or data', jobId: payload.jobId }));
          return;
        }

        // data is an array of bytes
        const buffer = Buffer.from(printData);
        
        try {
          const result = await printDirect(printerName, buffer);
          ws.send(JSON.stringify({ type: 'PRINT_OK', jobId: payload.jobId, result }));
        } catch (printErr) {
          console.error('[WS] Print Error:', printErr);
          ws.send(JSON.stringify({ type: 'PRINT_ERROR', error: printErr.toString(), jobId: payload.jobId }));
        }
      }
    } catch (err) {
      console.error('[WS] Invalid message format:', err);
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (!process.argv.includes('--silent')) {
      console.log('====================================================');
      console.log('⚠️  El puente de impresion YA ESTA FUNCIONANDO en segundo plano.');
      console.log('Esta ventana se cerrara sola en 3 segundos...');
      console.log('====================================================');
      setTimeout(() => process.exit(0), 3000);
    } else {
      process.exit(0);
    }
  } else {
    console.error('[Server Error]', e);
  }
});

server.listen(PORT, 'localhost', () => {
  if (!process.argv.includes('--silent')) {
    console.log(`[Rondapp PrintBridge] Running on ws://localhost:${PORT}`);
  }
});
