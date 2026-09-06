'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { createStorage, PublicError, isPlainObject, sanitizeJsonObject } = require('./storage.cjs');

const CHANNELS = Object.freeze({
  loadData: 'clinic:data:load',
  saveData: 'clinic:data:save',
  exportBackup: 'clinic:backup:export',
  importBackup: 'clinic:backup:import',
  restoreBackup: 'clinic:backup:restore',
  restorePreviousBackup: 'clinic:backup:restore-previous',
  getStorageInfo: 'clinic:storage:info',
  openDataFolder: 'clinic:storage:open-folder',
  setDirty: 'clinic:window:set-dirty',
  closeReady: 'clinic:window:close-ready',
  closeRequest: 'clinic:window:close-request',
  respondClose: 'clinic:window:respond-close',
  getPrinters: 'clinic:printer:list',
  print: 'clinic:printer:print',
});

const DATA_FILE_NAME = 'clinic-charge-data.json';
const SOURCE_ROOT = path.resolve(__dirname, '..', 'src');
const ENTRY_FILE = path.join(SOURCE_ROOT, 'index.html');

let mainWindow = null;
let storage = null;
let rendererDirty = false;
let closeReady = false;
let closeRequested = false;
let allowClose = false;

function isPathInside(basePath, candidatePath) {
  const relative = path.relative(path.resolve(basePath), path.resolve(candidatePath));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function getDataPath() {
  const userDataPath = path.resolve(app.getPath('userData'));
  const dataPath = path.resolve(userDataPath, DATA_FILE_NAME);
  if (!isPathInside(userDataPath, dataPath)) {
    throw new PublicError('本地数据路径无效。');
  }
  return dataPath;
}

function validateDialogJsonPath(filePath) {
  if (typeof filePath !== 'string' || filePath.includes('\0') || filePath.length > 4096) {
    throw new PublicError('选择的文件路径无效。');
  }
  let resolved = path.resolve(filePath);
  if (path.extname(resolved) === '') resolved += '.json';
  if (path.extname(resolved).toLowerCase() !== '.json' || path.basename(resolved) === '.json') {
    throw new PublicError('请选择 JSON 文件。');
  }
  return resolved;
}


function rendererUrlIsTrusted(urlString) {
  try {
    const url = new URL(urlString);
    if (url.protocol !== 'file:') return false;
    return isPathInside(SOURCE_ROOT, fileURLToPath(url));
  } catch {
    return false;
  }
}

function assertTrustedEvent(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new PublicError('请求来源无效。');
  }
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new PublicError('仅主页面可以执行此操作。');
  }
  if (!rendererUrlIsTrusted(event.senderFrame.url)) {
    throw new PublicError('页面来源无效。');
  }
}

function registerHandler(channel, publicFailureMessage, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertTrustedEvent(event);
      return await handler(event, ...args);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      console.error(`[${channel}]`, error);
      throw new Error(publicFailureMessage);
    }
  });
}

function optionalBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function optionalBoundedInteger(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function buildPrintOptions(rawInput) {
  const input = rawInput === undefined ? {} : sanitizeJsonObject(rawInput).clean;
  const profile = isPlainObject(input.profile) ? input.profile : {};
  const widthMm = Number(profile.paperWidthMm);
  const heightMm = Number(profile.paperHeightMm);
  const options = {
    silent: optionalBoolean(input.silent, false),
    printBackground: true,
    landscape: optionalBoolean(profile.landscape, false),
    copies: optionalBoundedInteger(input.copies, 1, 99, 1),
    margins: { marginType: 'none' },
  };

  if (Number.isFinite(widthMm) && Number.isFinite(heightMm)) {
    if (widthMm < 25 || widthMm > 500 || heightMm < 25 || heightMm > 500) {
      throw new PublicError('打印纸张尺寸超出允许范围。');
    }
    options.pageSize = {
      width: Math.round(widthMm * 1000),
      height: Math.round(heightMm * 1000),
    };
  }

  if (typeof input.deviceName === 'string' && input.deviceName.length > 0 && input.deviceName.length <= 256) {
    options.deviceName = input.deviceName;
  }
  return options;
}

function registerIpcHandlers() {
  registerHandler(CHANNELS.loadData, '读取本地数据失败。', async () => storage.loadData());
  registerHandler(CHANNELS.saveData, '保存本地数据失败。', async (_event, data) => storage.saveData(data));
  registerHandler(CHANNELS.restoreBackup, '恢复备份失败，原数据已保留。', async (_event, data) => storage.restoreBackup(data));
  registerHandler(CHANNELS.restorePreviousBackup, '恢复自动备份失败，原数据已保留。', async () => storage.restorePreviousBackup());
  registerHandler(CHANNELS.getStorageInfo, '读取数据位置失败。', async () => storage.getStorageInfo());
  registerHandler(CHANNELS.openDataFolder, '打开数据目录失败。', async () => {
    const directory = path.dirname(getDataPath());
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new PublicError('打开数据目录失败，请通过系统文件管理器访问。');
    return { ok: true };
  });
  registerHandler(CHANNELS.setDirty, '更新编辑状态失败。', async (_event, dirty) => {
    rendererDirty = dirty === true;
    return { ok: true };
  });
  registerHandler(CHANNELS.closeReady, '初始化关闭保护失败。', async () => {
    closeReady = true;
    return { ok: true };
  });
  registerHandler(CHANNELS.respondClose, '关闭软件失败。', async (_event, response) => {
    if (!closeRequested) return { ok: false };
    if (response?.action === 'cancel') {
      closeRequested = false;
      return { ok: true };
    }
    if (response?.action !== 'close') throw new PublicError('关闭操作无效。');
    await finishClose();
    return { ok: true };
  });

  registerHandler(CHANNELS.exportBackup, '导出备份失败。', async (_event, suppliedData) => {
    let data;
    if (suppliedData === undefined) {
      const loaded = await storage.loadData();
      if (loaded.data === null) throw new PublicError('当前没有可导出的数据。');
      data = loaded.data;
    } else {
      data = await storage.checkedStore(suppliedData);
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出门诊收费数据备份',
      defaultPath: `门诊收费数据备份-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true, backupProtection: 'plain-json', containsPlaintext: true };
    }

    const exportPath = validateDialogJsonPath(result.filePath);
    await storage.exportBackup(exportPath, data);
    return {
      ok: true,
      canceled: false,
      filePath: exportPath,
      backupProtection: 'plain-json',
      containsPlaintext: true,
    };
  });

  registerHandler(CHANNELS.importBackup, '导入备份失败。', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择门诊收费数据备份',
      filters: [{ name: 'JSON 备份', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length !== 1) {
      return { ok: false, canceled: true };
    }

    const importPath = validateDialogJsonPath(result.filePaths[0]);
    const parsed = await storage.readRegularJsonFile(importPath);
    if (parsed === null) throw new PublicError('备份文件不存在。');
    return {
      ok: true,
      canceled: false,
      filePath: importPath,
      data: await storage.extractBackupData(parsed),
      backupProtection: 'plain-json',
      containsPlaintext: true,
    };
  });

  registerHandler(CHANNELS.getPrinters, '读取打印机列表失败。', async (event) => {
    const printers = await event.sender.getPrintersAsync();
    return printers.map((printer) => ({
      name: String(printer.name || ''),
      displayName: String(printer.displayName || printer.name || ''),
      description: String(printer.description || ''),
      status: Number.isFinite(printer.status) ? printer.status : 0,
      isDefault: Boolean(printer.isDefault),
    }));
  });

  registerHandler(CHANNELS.print, '打印失败。', async (event, options) => {
    const printOptions = buildPrintOptions(options);
    return new Promise((resolve, reject) => {
      event.sender.print(printOptions, (success, failureReason) => {
        if (success) resolve({ ok: true, success: true, canceled: false });
        else reject(new PublicError(failureReason || '打印已取消或未完成。'));
      });
    });
  });
}

async function finishClose() {
  await storage.whenIdle();
  allowClose = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
}

function hardenSession() {
  const activeSession = session.defaultSession;
  activeSession.setPermissionCheckHandler(() => false);
  activeSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  activeSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: '门诊收费录入打印软件',
    backgroundColor: '#f4f1ea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      devTools: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!rendererUrlIsTrusted(targetUrl)) event.preventDefault();
  });
  mainWindow.webContents.on('render-process-gone', () => {
    closeReady = false;
    closeRequested = false;
  });
  mainWindow.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    if (closeRequested) return;
    closeRequested = true;
    if (closeReady) {
      mainWindow.webContents.send(CHANNELS.closeRequest, { dirty: rendererDirty });
    } else {
      finishClose().catch((error) => {
        closeRequested = false;
        console.error('[window:close]', error);
      });
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(ENTRY_FILE).then(async () => {
    if (smokeTest) await require('../scripts/windows-smoke.cjs').runAppSmoke({ app, mainWindow, userDataPath: app.getPath('userData') });
  }).catch((error) => {
    console.error('[window:load]', error);
    dialog.showErrorBox('启动失败', '无法加载软件界面，请重新安装后再试。');
    app.quit();
  });
}

const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest || process.env.CLINIC_SMOKE_USER_DATA) {
  const selectedPath = process.env.CLINIC_SMOKE_USER_DATA || '';
  const resolved = path.resolve(selectedPath);
  const temporaryRoot = path.resolve(os.tmpdir());
  let safeDirectory = false;
  try {
    const stats = fsSync.lstatSync(resolved);
    safeDirectory = stats.isDirectory() && !stats.isSymbolicLink();
  } catch {}
  if (!smokeTest || !path.isAbsolute(selectedPath) || !isPathInside(temporaryRoot, resolved)
    || resolved === temporaryRoot || !path.basename(resolved).startsWith('clinic-smoke-')
    || path.dirname(resolved) !== temporaryRoot || !safeDirectory) {
    console.error('Smoke test requires an isolated clinic-smoke- directory directly inside the system temporary directory.');
    app.exit(1);
  } else {
    app.setPath('userData', resolved);
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    storage = createStorage({ dataPath: getDataPath(), safeStorage });
    hardenSession();
    registerIpcHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
