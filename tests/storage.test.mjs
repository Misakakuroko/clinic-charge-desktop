import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { createEmptyStore, createDraftDocument } from '../src/domain.mjs';

const require = createRequire(import.meta.url);
const { createStorage, MAX_DATA_BYTES, MAX_NODES, sanitizeJsonObject } = require('../electron/storage.cjs');
const plainStorage = { isEncryptionAvailable: () => false };
const fakeEncryption = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from(`test-envelope:${text}`),
  decryptString: (data) => {
    const text = data.toString();
    if (!text.startsWith('test-envelope:')) throw new Error('invalid ciphertext');
    return text.slice('test-envelope:'.length);
  },
};

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-storage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const dataPath = path.join(directory, 'clinic-charge-data.json');
  return { directory, dataPath, storage: createStorage({ dataPath, safeStorage: plainStorage, ...options }) };
}

function storeNamed(name) {
  const store = createEmptyStore();
  store.settings.organizationName = name;
  return store;
}

test('保存及重新创建存储对象读取使用相同业务校验，坏数据不能覆盖好数据', async (t) => {
  const { storage, dataPath } = await fixture(t);
  const original = storeNamed('测试门诊甲');
  await storage.saveData(original);
  await assert.rejects(storage.saveData({}), /数据|版本|结构/);
  const fresh = createStorage({ dataPath, safeStorage: plainStorage });
  assert.deepEqual((await fresh.loadData()).data, original);
  await assert.rejects(storage.extractBackupData({}), /数据|版本|结构/);
  await assert.rejects(storage.extractBackupData({ format: 'unrelated', version: 1, data: original }), /不是/);
  await assert.rejects(storage.extractBackupData({ format: 'clinic-charge-backup', version: 2, data: original }), /版本/);
  assert.deepEqual(await storage.extractBackupData({ format: 'clinic-charge-backup', version: 1, data: original }), original);
  assert.deepEqual(await storage.extractBackupData(original), original);
});

test('连续保存按调用先后写入，修改调用方对象不影响已排队快照', async (t) => {
  const { directory, dataPath } = await fixture(t);
  let releaseFirst;
  let announceFirst;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let dataRenames = 0;
  const delayedFs = {
    ...fs,
    async rename(source, destination) {
      if (destination === dataPath && ++dataRenames === 1) { announceFirst(); await firstGate; }
      return fs.rename(source, destination);
    },
  };
  const storage = createStorage({ dataPath, safeStorage: plainStorage, fileSystem: delayedFs });
  const first = storeNamed('第一次');
  const firstSave = storage.saveData(first);
  await firstStarted;
  const second = storeNamed('第二次');
  const secondSave = storage.saveData(second);
  second.settings.organizationName = '调用方随后修改';
  assert.equal(storage.pendingWrites, 2);
  let idleResolved = false;
  const idle = storage.whenIdle().then(() => { idleResolved = true; });
  await Promise.resolve();
  assert.equal(idleResolved, false);
  releaseFirst();
  await Promise.all([firstSave, secondSave, idle]);
  assert.equal((await storage.loadData()).data.settings.organizationName, '第二次');
  assert.equal(JSON.parse(await fs.readFile(`${dataPath}.prev`, 'utf8')).data.settings.organizationName, '第一次');
  assert.equal(storage.pendingWrites, 0);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('写盘失败保留原数据，清理临时文件，后续保存可继续', async (t) => {
  const { directory, dataPath, storage: originalStorage } = await fixture(t);
  await originalStorage.saveData(storeNamed('原始记录'));
  let failOnce = true;
  const failingFs = {
    ...fs,
    async rename(source, destination) {
      if (destination === dataPath && failOnce) { failOnce = false; throw Object.assign(new Error('disk failed'), { code: 'EIO' }); }
      return fs.rename(source, destination);
    },
  };
  const storage = createStorage({ dataPath, safeStorage: plainStorage, fileSystem: failingFs });
  await assert.rejects(storage.saveData(storeNamed('失败写入')), /disk failed/);
  assert.equal((await storage.loadData()).data.settings.organizationName, '原始记录');
  await storage.saveData(storeNamed('重试成功'));
  assert.equal((await storage.loadData()).data.settings.organizationName, '重试成功');
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('损坏数据启动失败后可独立恢复自动副本，原始故障文件保留', async (t) => {
  const { storage, dataPath } = await fixture(t);
  await storage.saveData(storeNamed('上一份正确记录'));
  await storage.saveData(storeNamed('后一次记录'));
  const corruptText = '{bad-data';
  await fs.writeFile(dataPath, corruptText);
  const restarted = createStorage({ dataPath, safeStorage: plainStorage });
  await assert.rejects(restarted.loadData(), /JSON/);
  await assert.rejects(restarted.saveData(storeNamed('不能静默覆盖')), /停止覆盖/);
  const result = await restarted.restorePreviousBackup();
  assert.equal(result.data.settings.organizationName, '上一份正确记录');
  assert.equal(await fs.readFile(result.preservedPath, 'utf8'), corruptText);
  assert.equal((await restarted.loadData()).data.settings.organizationName, '上一份正确记录');
});

test('导入无效备份不改动原文件，有效导入保存恢复前的完整副本', async (t) => {
  const { storage, dataPath } = await fixture(t);
  await storage.saveData(storeNamed('导入前'));
  const before = await fs.readFile(dataPath, 'utf8');
  await assert.rejects(storage.restoreBackup({}), /数据|版本|结构/);
  assert.equal(await fs.readFile(dataPath, 'utf8'), before);
  const result = await storage.restoreBackup(storeNamed('导入后'));
  assert.equal(await fs.readFile(result.preservedPath, 'utf8'), before);
  assert.equal((await storage.loadData()).data.settings.organizationName, '导入后');
});

test('主文件缺失而自动备份存在时不当成空数据库', async (t) => {
  const { storage, dataPath } = await fixture(t);
  await storage.saveData(storeNamed('甲'));
  await storage.saveData(storeNamed('乙'));
  await fs.unlink(dataPath);
  await assert.rejects(storage.loadData(), /主数据文件缺失/);
  await assert.rejects(storage.saveData(createEmptyStore()), /停止覆盖/);
  await storage.restorePreviousBackup();
  assert.equal((await storage.loadData()).data.settings.organizationName, '甲');
});

test('内容为 null 的现存数据文件不能被当成从未建库', async (t) => {
  const { storage, dataPath } = await fixture(t);
  await fs.writeFile(dataPath, 'null');
  await assert.rejects(storage.loadData(), /普通对象/);
  await assert.rejects(storage.saveData(createEmptyStore()), /停止覆盖/);
  assert.equal(await fs.readFile(dataPath, 'utf8'), 'null');
});

test('保留系统加密存储和明文跨机备份，导出不能覆盖本地库', async (t) => {
  const { directory, dataPath, storage } = await fixture(t, { safeStorage: fakeEncryption });
  await storage.saveData(storeNamed('加密测试'));
  const localEnvelope = JSON.parse(await fs.readFile(dataPath, 'utf8'));
  assert.equal(localEnvelope.storageProtection, 'encrypted-v1');
  assert.equal(Object.hasOwn(localEnvelope, 'data'), false);
  assert.equal((await storage.loadData()).data.settings.organizationName, '加密测试');
  const backupPath = path.join(directory, 'export.json');
  await storage.exportBackup(backupPath, (await storage.loadData()).data);
  const exported = JSON.parse(await fs.readFile(backupPath, 'utf8'));
  assert.equal(exported.format, 'clinic-charge-backup');
  assert.equal(exported.version, 1);
  assert.equal((await storage.extractBackupData(exported)).settings.organizationName, '加密测试');
  await assert.rejects(storage.exportBackup(dataPath, createEmptyStore()), /不能覆盖/);
});

test('一万张每张五项目通过存入、备份和重启读取', async (t) => {
  const { directory, storage, dataPath } = await fixture(t);
  const store = createEmptyStore();
  const template = createDraftDocument({
    patientName: '匿名样本', businessDate: '2026-09-06',
    lines: Array.from({ length: 5 }, (_, i) => ({ item: { id: `item-${i}`, name: `测试项目${i}`, unit: '次', unitPriceCents: 100 }, quantity: 2 })),
  });
  for (let i = 0; i < 10000; i += 1) {
    const document = structuredClone(template);
    document.id = `test-doc-${i}`;
    const day = String(6 + Math.floor(i / 1000)).padStart(2, '0');
    document.businessDate = `2026-09-${day}`;
    document.serial = `202609${day}${String(i % 1000 + 1).padStart(4, '0')}`;
    document.lines.forEach((line, j) => { line.id = `line-${i}-${j}`; });
    store.documents.push(document);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(store)) < MAX_DATA_BYTES);
  assert.equal(MAX_NODES, 4_000_000);
  await storage.saveData(store);
  const backupPath = path.join(directory, 'large-backup.json');
  await storage.exportBackup(backupPath, store);
  assert.equal((await storage.extractBackupData(await storage.readRegularJsonFile(backupPath))).documents.length, 10000);
  const restarted = createStorage({ dataPath, safeStorage: plainStorage });
  assert.equal((await restarted.loadData()).data.documents.length, 10000);
});

test('仍拒绝非有限数字、危险键、循环数据和过深对象', () => {
  assert.throws(() => sanitizeJsonObject({ n: NaN }), /无效数字/);
  assert.throws(() => sanitizeJsonObject(JSON.parse('{"__proto__":{}}')), /不安全/);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => sanitizeJsonObject(cyclic), /循环/);
  let deep = {};
  for (let i = 0; i < 50; i += 1) deep = { value: deep };
  assert.throws(() => sanitizeJsonObject(deep), /嵌套/);
});
