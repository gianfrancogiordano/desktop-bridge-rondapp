/**
 * Cleanup of the previous pkg-based bridge (v1.x). Best effort: never throws.
 *
 *  Windows: kills `rondapp-bridge-win.exe` and removes its Startup `.vbs` launcher.
 *  macOS:   unloads/removes the `com.rondapp.bridge` LaunchAgent and kills `rondapp-bridge-mac`.
 *
 * The old bridge may still hold port 17842 (and, with KeepAlive, would respawn forever).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ err, out: String(stdout || '').trim() }));
  });
}

async function cleanupWindows() {
  const vbs = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu',
    'Programs', 'Startup', 'rondapp-bridge.vbs');
  try {
    if (fs.existsSync(vbs)) {
      fs.unlinkSync(vbs);
      logger.info('Removed legacy startup launcher:', vbs);
    }
  } catch (err) {
    logger.warn('Could not remove legacy launcher:', err.message);
  }
  const { err, out } = await exec('taskkill', ['/F', '/IM', 'rondapp-bridge-win.exe']);
  if (!err) logger.info('Killed legacy bridge process:', out);
}

async function cleanupMac() {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.rondapp.bridge.plist');
  if (fs.existsSync(plist)) {
    // bootout first, otherwise KeepAlive respawns the process right after we kill it
    await exec('launchctl', ['bootout', `gui/${process.getuid()}`, plist]);
    try {
      fs.unlinkSync(plist);
      logger.info('Removed legacy LaunchAgent:', plist);
    } catch (err) {
      logger.warn('Could not remove legacy LaunchAgent:', err.message);
    }
  }
  const { err } = await exec('pkill', ['-f', 'rondapp-bridge-mac']);
  if (!err) logger.info('Killed legacy bridge process');
}

async function cleanupLegacyBridge() {
  try {
    if (process.platform === 'win32') await cleanupWindows();
    else if (process.platform === 'darwin') await cleanupMac();
  } catch (err) {
    logger.warn('Legacy cleanup failed:', err.message);
  }
}

module.exports = { cleanupLegacyBridge };
