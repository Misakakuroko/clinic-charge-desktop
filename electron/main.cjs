'use strict';

const { app, BrowserWindow, dialog, ipcMain, safeStorage, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');

const CHANNELS = Object.freeze({
  loadData: 'clinic:data:load',
  saveData: 'clinic:data:save',
  exportBackup: 'clinic:backup:export',
  importBackup: 'clinic:backup:import',
  getPrinters: 'clinic:printer:list',
  print: 'clinic:printer:print',
});

const DATA_FILE_NAME = 'clinic-charge-data.json';
const DATA_FORMAT = 'clinic-charge-data';
const BACKUP_FORMAT = 'clinic-charge-backup';
const FORMAT_VERSION = 1;
const MAX_DATA_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_NODES = 150000;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SOURCE_ROOT = path.resolve(__dirname, '..', 'src');
const ENTRY_FILE = path.join(SOURCE_ROOT, 'index.html');

let mainWindow = null;

class PublicError extends Error {}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeJsonObject(input) {
  if (!isPlainObject(input)) {
    throw new PublicError('数据必须是普通对象。');
  }

  const seen = new WeakSet();
  let nodes = 0;

  function visit(value, depth) {
    nodes += 1;
    if (nodes > MAX_NODES) throw new PublicError('数据项目过多，无法处理。');
    if (depth > MAX_DEPTH) throw new PublicError('数据嵌套层级过深。');

    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new PublicError('数据包含无效数字。');
      return value;
    }
    if (typeof value !== 'object') {
      throw new PublicError('数据只能包含可保存的 JSON 值。');
    }
    if (seen.has(value)) throw new PublicError('数据不能循环引用。');
    seen.add(value);

    let result;
    if (Array.isArray(value)) {
      result = value.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(value)) throw new PublicError('数据包含非普通对象。');
      result = {};
      for (const [key, child] of Object.entries(value)) {
        if (BLOCKED_KEYS.has(key)) throw new PublicError('数据包含不安全的字段名。');
        if (key.length > 256) throw new PublicError('数据字段名过长。');
        result[key] = visit(child, depth + 1);
      }
    }

    seen.delete(value);
    return result;
  }

  const clean = visit(input, 0);
  const serialized = JSON.stringify(clean);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
    throw new PublicError('数据超过 10 MB，无法保存。');
  }
  return { clean, serialized };
}

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

async function writeAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );

  try {
    await fs.writeFile(temporaryPath, contents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function currentStorageProtection() {
  return safeStorage.isEncryptionAvailable() ? 'encrypted-v1' : 'plain-v1';
}

async function saveLocalData(input) {
  const { clean, serialized } = sanitizeJsonObject(input);
  const storageProtection = currentStorageProtection();
  let envelope;

  if (storageProtection === 'encrypted-v1') {
    envelope = {
      format: DATA_FORMAT,
      version: FORMAT_VERSION,
      storageProtection,
      payload: safeStorage.encryptString(serialized).toString('base64'),
    };
  } else {
    envelope = {
      format: DATA_FORMAT,
      version: FORMAT_VERSION,
      storageProtection,
      data: clean,
    };
  }

  await writeAtomic(getDataPath(), `${JSON.stringify(envelope, null, 2)}\n`);
  return { ok: true, storageProtection };
}

async function readRegularJsonFile(filePath) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new PublicError('所选路径不是可读取的普通文件。');
  }
  if (stats.size > MAX_FILE_BYTES) throw new PublicError('文件过大，无法读取。');
  const text = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicError('文件不是有效的 JSON 数据。');
  }
}

async function loadLocalData() {
  const stored = await readRegularJsonFile(getDataPath());
  if (stored === null) {
    return { data: null, storageProtection: currentStorageProtection() };
  }

  if (isPlainObject(stored) && stored.format === DATA_FORMAT && stored.version === FORMAT_VERSION) {
    if (stored.storageProtection === 'encrypted-v1') {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new PublicError('系统安全存储当前不可用，无法解密本地数据。');
      }
      if (typeof stored.payload !== 'string' || stored.payload.length > MAX_FILE_BYTES * 2) {
        throw new PublicError('本地加密数据格式无效。');
      }
      let decrypted;
      try {
        decrypted = safeStorage.decryptString(Buffer.from(stored.payload, 'base64'));
      } catch {
        throw new PublicError('本地数据无法解密，可能来自另一台电脑或已经损坏。');
      }
      let parsed;
      try {
        parsed = JSON.parse(decrypted);
      } catch {
        throw new PublicError('解密后的本地数据格式无效。');
      }
      return { data: sanitizeJsonObject(parsed).clean, storageProtection: 'encrypted-v1' };
    }

    if (stored.storageProtection === 'plain-v1') {
      return { data: sanitizeJsonObject(stored.data).clean, storageProtection: 'plain-v1' };
    }
    throw new PublicError('本地数据使用了不支持的存储格式。');
  }

  // 兼容最早期直接写入对象的本地数据。
  return { data: sanitizeJsonObject(stored).clean, storageProtection: 'plain-v1' };
}

function extractBackupData(parsed) {
  if (isPlainObject(parsed) && parsed.format === BACKUP_FORMAT) {
    if (parsed.version !== FORMAT_VERSION) throw new PublicError('备份版本暂不支持。');
    return sanitizeJsonObject(parsed.data).clean;
  }
  return sanitizeJsonObject(parsed).clean;
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
  registerHandler(CHANNELS.loadData, '读取本地数据失败。', async () => loadLocalData());
  registerHandler(CHANNELS.saveData, '保存本地数据失败。', async (_event, data) => saveLocalData(data));

  registerHandler(CHANNELS.exportBackup, '导出备份失败。', async (_event, suppliedData) => {
    let data;
    if (suppliedData === undefined) {
      const loaded = await loadLocalData();
      if (loaded.data === null) throw new PublicError('当前没有可导出的数据。');
      data = loaded.data;
    } else {
      data = sanitizeJsonObject(suppliedData).clean;
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
    const backup = {
      format: BACKUP_FORMAT,
      version: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      data,
    };
    await writeAtomic(exportPath, `${JSON.stringify(backup, null, 2)}\n`);
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
    const parsed = await readRegularJsonFile(importPath);
    if (parsed === null) throw new PublicError('备份文件不存在。');
    return {
      ok: true,
      canceled: false,
      filePath: importPath,
      data: extractBackupData(parsed),
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
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.loadFile(ENTRY_FILE).catch((error) => {
    console.error('[window:load]', error);
    dialog.showErrorBox('启动失败', '无法加载软件界面，请重新安装后再试。');
    app.quit();
  });
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
    hardenSession();
    registerIpcHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
