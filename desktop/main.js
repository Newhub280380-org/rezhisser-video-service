'use strict';

// Electron entry point for the «Режиссёр» desktop app. It opens the cloud
// service (REZHISSER_URL) or starts the bundled server locally, then shows
// the Owl Browser task dashboard (/automation) in a locked-down window.

const path = require('node:path');
const { app, BrowserWindow, dialog, session, shell } = require('electron');
const { resolveDesktopConfig, classifyNavigation, startLocalServer } = require('./config.js');

let localServer = null;
let mainWindow = null;
let target = null;

function serverModulePath() {
  // Packaged builds ship src/ and public/ as extra resources (see package.json).
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'src', 'server.js')
    : path.join(__dirname, '..', 'src', 'server.js');
}

// Resolves once: { origin, startPath } of the cloud service or local server.
async function resolveTarget() {
  if (target) return target;
  const config = resolveDesktopConfig(process.env);
  let origin = config.origin;
  if (config.mode === 'local') {
    const { createApp } = require(serverModulePath());
    localServer = await startLocalServer({ createApp, userDataDir: app.getPath('userData') });
    origin = localServer.origin;
  }
  target = { origin, startPath: config.startPath };
  return target;
}

function lockDown(contents, origin) {
  contents.setWindowOpenHandler(({ url }) => {
    if (classifyNavigation(url, origin) === 'external') shell.openExternal(url).catch(() => null);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    const kind = classifyNavigation(url, origin);
    if (kind === 'internal') return;
    event.preventDefault();
    if (kind === 'external') shell.openExternal(url).catch(() => null);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow() {
  const { origin, startPath } = await resolveTarget();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Режиссёр — Owl Browser',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  lockDown(mainWindow.webContents, origin);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`${origin}${startPath}`);
}

function fail(error) {
  dialog.showErrorBox('Режиссёр', `Не удалось запустить приложение: ${error.message}`);
  app.quit();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    return createWindow();
  }).catch(fail);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(fail);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (!localServer) return;
    event.preventDefault();
    const server = localServer;
    localServer = null;
    server.close().catch(() => null).finally(() => app.quit());
  });
}
