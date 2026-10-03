const printer = require('@thiagoelg/node-printer');

/**
 * Returns a list of installed printers on the OS.
 */
function getPrinters() {
  try {
    const list = printer.getPrinters();
    const defaultPrinterName = printer.getDefaultPrinterName();
    
    return list.map(p => ({
      name: p.name,
      isDefault: p.name === defaultPrinterName,
      status: p.status,
      options: p.options
    }));
  } catch (err) {
    console.error('[Printer] Error getting printers:', err);
    return [];
  }
}

/**
 * Sends a raw buffer (ESC/POS bytes) directly to the printer spooler.
 * @param {string} printerName 
 * @param {Buffer} buffer 
 * @returns {Promise<string>} jobId
 */
function printDirect(printerName, buffer) {
  return new Promise((resolve, reject) => {
    printer.printDirect({
      data: buffer,
      printer: printerName,
      type: 'RAW',
      success: (jobId) => {
        resolve(jobId);
      },
      error: (err) => {
        reject(err);
      }
    });
  });
}

module.exports = {
  getPrinters,
  printDirect
};
