'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { constants } = require('node:fs');

const DATA_FORMAT = 'clinic-charge-data';
const BACKUP_FORMAT = 'clinic-charge-backup';
const FORMAT_VERSION = 1;
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 4_000_000;
const MAX_DEPTH = 48;
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

class PublicError extends Error {}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeJsonObject(input) {
  if (!isPlainObject(input)) throw new PublicError('数据必须是普通对象。');
  const seen = new WeakSet();
  let nodes = 0;
  function visit(value, depth) {
    if (++nodes > MAX_NODES) throw new PublicError('数据项目过多，无法处理。');
    if (depth > MAX_DEPTH) throw new PublicError('数据嵌套层级过深。');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new PublicError('数据包含无效数字。');
      return value;
    }
    if (typeof value !== 'object') throw new PublicError('数据只能包含可保存的 JSON 值。');
    if (seen.has(value)) throw new PublicError('数据不能循环引用。');
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map((item) => visit(item, depth + 1));
    else {
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
    throw new PublicError('数据超过 64 MiB，请先导出备份并联系维护者。');
  }
  return { clean, serialized };
}

async function writeAtomic(filePath, contents, fileSystem = fs) {
  if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new PublicError('文件超过 128 MiB，无法写入。');
  const directory = path.dirname(filePath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fileSystem.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function createStorage({ dataPath, safeStorage, fileSystem = fs, validateStore } = {}) {
  if (!path.isAbsolute(dataPath)) throw new Error('dataPath must be absolute');
  const previousBackupPath = `${dataPath}.prev`;
  let queue = Promise.resolve();
  let pendingWrites = 0;
  const validate = validateStore || (async (data) => {
    const { validateStoredStore } = await import('../src/domain.mjs');
    return validateStoredStore(data);
  });

  function enqueue(operation) {
    pendingWrites += 1;
    const result = queue.then(operation);
    queue = result.then(() => {}, () => {}).finally(() => { pendingWrites -= 1; });
    return result;
  }

  function currentStorageProtection() {
    return safeStorage.isEncryptionAvailable() ? 'encrypted-v1' : 'plain-v1';
  }

  async function checkedStore(input) {
    const { clean } = sanitizeJsonObject(input);
    try {
      await validate(clean);
    } catch (error) {
      throw new PublicError(error?.message || '数据格式或内容无效。');
    }
    return clean;
  }

  async function readRegularFile(filePath) {
    let stats;
    try { stats = await fileSystem.lstat(filePath); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new PublicError('所选路径不是可读取的普通文件。');
    if (stats.size > MAX_FILE_BYTES) throw new PublicError('文件超过 128 MiB，无法读取。');
    const text = await fileSystem.readFile(filePath, 'utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new PublicError('文件超过 128 MiB，无法读取。');
    return text;
  }

  async function readRegularJsonFile(filePath) {
    const text = await readRegularFile(filePath);
    if (text === null) return null;
    try { return JSON.parse(text); }
    catch { throw new PublicError('文件不是有效的 JSON 数据。'); }
  }

  async function decodeLocal(stored) {
    if (isPlainObject(stored) && stored.format === DATA_FORMAT) {
      if (stored.version !== FORMAT_VERSION) throw new PublicError('本地数据版本暂不支持。');
      if (stored.storageProtection === 'plain-v1') {
        return { data: await checkedStore(stored.data), storageProtection: 'plain-v1' };
      }
      if (stored.storageProtection !== 'encrypted-v1') throw new PublicError('本地数据使用了不支持的存储格式。');
      if (!safeStorage.isEncryptionAvailable()) throw new PublicError('系统安全存储当前不可用，无法解密本地数据。');
      if (typeof stored.payload !== 'string' || stored.payload.length > MAX_FILE_BYTES) {
        throw new PublicError('本地加密数据格式无效。');
      }
      let decrypted;
      try { decrypted = safeStorage.decryptString(Buffer.from(stored.payload, 'base64')); }
      catch { throw new PublicError('本地数据无法解密，可能来自另一台电脑或已经损坏。'); }
      if (Buffer.byteLength(decrypted, 'utf8') > MAX_DATA_BYTES) throw new PublicError('本地数据超过 64 MiB。');
      let parsed;
      try { parsed = JSON.parse(decrypted); }
      catch { throw new PublicError('解密后的本地数据格式无效。'); }
      return { data: await checkedStore(parsed), storageProtection: 'encrypted-v1' };
    }
    return { data: await checkedStore(stored), storageProtection: 'plain-v1' };
  }

  async function loadData() {
    await queue;
    const contents = await readRegularFile(dataPath);
    if (contents === null) {
      try {
        await fileSystem.lstat(previousBackupPath);
        throw new PublicError('主数据文件缺失，但存在自动备份。请先恢复备份后继续。');
      } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      return { data: null, storageProtection: currentStorageProtection() };
    }
    let stored;
    try { stored = JSON.parse(contents); }
    catch { throw new PublicError('文件不是有效的 JSON 数据。'); }
    return decodeLocal(stored);
  }

  async function encodeData(data) {
    const checked = await checkedStore(data);
    const protection = currentStorageProtection();
    const base = { format: DATA_FORMAT, version: FORMAT_VERSION, storageProtection: protection };
    const envelope = protection === 'encrypted-v1'
      ? { ...base, payload: safeStorage.encryptString(JSON.stringify(checked)).toString('base64') }
      : { ...base, data: checked };
    return { contents: `${JSON.stringify(envelope)}\n`, storageProtection: protection };
  }

  async function preserveCurrent() {
    let stats;
    try { stats = await fileSystem.lstat(dataPath); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    if (!stats.isFile() || stats.isSymbolicLink()) throw new PublicError('原数据不是普通文件，恢复已中止。');
    const preservedPath = `${dataPath}.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
    await fileSystem.copyFile(dataPath, preservedPath, constants.COPYFILE_EXCL);
    const handle = await fileSystem.open(preservedPath, 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
    return preservedPath;
  }

  async function commit(data, restoring = false) {
    const encoded = await encodeData(data);
    let priorText = null;
    let priorIsValid = false;
    try {
      priorText = await readRegularFile(dataPath);
      if (priorText !== null) {
        await decodeLocal(JSON.parse(priorText));
        priorIsValid = true;
      } else if (!restoring) {
        try {
          await fileSystem.lstat(previousBackupPath);
          throw new PublicError('主数据缺失，存在自动备份，不能直接覆盖。');
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      if (!restoring) throw new PublicError('现有数据无法读取，已停止覆盖。请先在恢复页面恢复备份。');
    }
    const preservedPath = restoring ? await preserveCurrent() : null;
    if (priorIsValid) await writeAtomic(previousBackupPath, priorText, fileSystem);
    await writeAtomic(dataPath, encoded.contents, fileSystem);
    return { ok: true, storageProtection: encoded.storageProtection, ...(preservedPath ? { preservedPath } : {}) };
  }

  function saveData(data) {
    const snapshot = sanitizeJsonObject(data).clean;
    return enqueue(() => commit(snapshot));
  }

  async function extractBackupData(parsed) {
    if (isPlainObject(parsed) && parsed.format === BACKUP_FORMAT) {
      if (parsed.version !== FORMAT_VERSION) throw new PublicError('备份版本暂不支持。');
      return checkedStore(parsed.data);
    }
    if (isPlainObject(parsed) && parsed.format !== undefined) throw new PublicError('这不是门诊收费软件的数据备份。');
    return checkedStore(parsed);
  }

  function restoreBackup(data) {
    const snapshot = sanitizeJsonObject(data).clean;
    return enqueue(() => commit(snapshot, true));
  }

  function restorePreviousBackup() {
    return enqueue(async () => {
      const parsed = await readRegularJsonFile(previousBackupPath);
      if (parsed === null) throw new PublicError('没有可恢复的自动备份。');
      const loaded = await decodeLocal(parsed);
      const result = await commit(loaded.data, true);
      return { ...result, data: loaded.data };
    });
  }

  async function exportBackup(filePath, data) {
    const snapshot = await checkedStore(data);
    const exportPath = path.resolve(filePath);
    const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
    if ([dataPath, previousBackupPath].map(pathKey).includes(pathKey(exportPath))) throw new PublicError('请选择其他位置，不能覆盖软件自身的数据文件。');
    return enqueue(() => writeAtomic(exportPath, `${JSON.stringify({
      format: BACKUP_FORMAT, version: FORMAT_VERSION, exportedAt: new Date().toISOString(), data: snapshot,
    }, null, 2)}\n`, fileSystem));
  }

  async function getStorageInfo() {
    let previousBackupAvailable = false;
    try { const stats = await fileSystem.lstat(previousBackupPath); previousBackupAvailable = stats.isFile() && !stats.isSymbolicLink(); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    return { dataPath, previousBackupPath, previousBackupAvailable, storageProtection: currentStorageProtection(), maxDataBytes: MAX_DATA_BYTES };
  }

  return {
    loadData, saveData, restoreBackup, restorePreviousBackup, exportBackup, extractBackupData,
    readRegularJsonFile, checkedStore, getStorageInfo,
    whenIdle: async () => { while (pendingWrites > 0) await queue; },
    get pendingWrites() { return pendingWrites; },
  };
}

module.exports = { createStorage, PublicError, isPlainObject, sanitizeJsonObject, MAX_DATA_BYTES, MAX_FILE_BYTES, MAX_NODES };
