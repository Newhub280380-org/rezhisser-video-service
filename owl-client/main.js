'use strict';

// Electron entry point of the standalone Owl Browser client. No backend
// server: the main process talks directly to the cloud Owl Browser API, the
// window only shows the task form and the log (no Node.js, no network).

const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { createOwlClient, MAX_TASK_CHARS } = require('./owl-api.js');
const { loadSettings, saveSettings, publicSettings } = require('./settings.js');

const PAGE = path.join(__dirname, 'renderer', 'index.html');

let mainWindow = null;
let settings = null;
let running = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function crypto() {
  if (!safeStorage.isEncryptionAvailable()) return { encrypt: null, decrypt: null };
  return {
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
  };
}

function fromOurWindow(event) {
  return Boolean(mainWindow) && event.sender === mainWindow.webContents;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function registerIpc() {
  ipcMain.handle('settings:get', (event) => {
    if (!fromOurWindow(event)) throw new Error('forbidden');
    return { ...publicSettings(settings), maxTaskChars: MAX_TASK_CHARS };
  });

  ipcMain.handle('settings:save', (event, input) => {
    if (!fromOurWindow(event)) throw new Error('forbidden');
    const data = input && typeof input === 'object' ? input : {};
    const token = data.clearToken ? '' : (typeof data.token === 'string' && data.token.trim()) || settings.token;
    try {
      const saved = saveSettings(settingsFile(), { url: data.url, token }, { encrypt: crypto().encrypt });
      settings = { url: saved.url, token: saved.token };
      return { ok: true, ...publicSettings(settings), tokenPersisted: saved.persisted };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('task:run', async (event, input) => {
    if (!fromOurWindow(event)) throw new Error('forbidden');
    if (running) return { ok: false, error: 'Задача уже выполняется. Дождитесь окончания или нажмите «Стоп».' };
    const data = input && typeof input === 'object' ? input : {};
    const controller = new AbortController();
    running = controller;
    try {
      const client = createOwlClient({ url: settings.url, token: settings.token });
      const log = (line) => send('task:log', { time: new Date().toISOString(), line: String(line) });
      const result = await client.runTask({ task: data.task, startUrl: data.startUrl }, { log, signal: controller.signal });
      return { ok: true, summary: result.summary };
    } catch (error) {
      return { ok: false, code: error.code || 'error', error: error.message };
    } finally {
      running = null;
    }
  });

  ipcMain.handle('task:stop', (event) => {
    if (!fromOurWindow(event)) throw new Error('forbidden');
    if (!running) return false;
    running.abort();
    return true;
  });
}

function lockDown(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => null);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    title: 'Owl Browser — клиент',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  lockDown(mainWindow.webContents);
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (running) running.abort();
  });
  await mainWindow.loadFile(PAGE);
}

function fail(error) {
  dialog.showErrorBox('Owl Browser', `Не удалось запустить приложение: ${error.message}`);
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
    settings = loadSettings(settingsFile(), { decrypt: crypto().decrypt, env: process.env });
    registerIpc();
    return createWindow();
  }).catch(fail);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(fail);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
