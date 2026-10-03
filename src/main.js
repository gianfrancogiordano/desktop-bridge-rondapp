const WebSocket = require('ws');
const http = require('http');
const { getPrinters, printDirect } = require('./printer');

const PORT = 17842;

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

server.listen(PORT, 'localhost', () => {
  console.log(`[Rondapp PrintBridge] Running on ws://localhost:${PORT}`);
});
