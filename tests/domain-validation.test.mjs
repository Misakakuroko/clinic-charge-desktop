import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainError,
  MAX_CATALOG_ITEMS,
  MAX_DOCUMENTS,
  confirmDocument,
  createDraftDocument,
  createEmptyStore,
  getStoreCapacity,
  normalizeCatalogItem,
  normalizeStore,
  parsePositiveQuantity,
  validateStoredStore,
  voidDocument,
} from "../src/domain.mjs";

const now = "2026-09-06T10:00:00.000Z";
const clone = (value) => structuredClone(value);

function fixture() {
  const store = createEmptyStore();
  const item = normalizeCatalogItem({
    id: "catalog-1", code: "TEST", name: "测试项目", unit: "次", unitPriceCents: 101,
  }, { now });
  store.catalogItems.push(item);
  let counter = 0;
  store.documents.push(createDraftDocument({
    id: "document-1", serial: "202609060001", businessDate: "2026-09-06",
    patientName: "测试姓名", lines: [{ item, quantity: "1.5" }],
  }, { now, idFactory: (prefix) => `${prefix}-${++counter}` }));
  return store;
}

test("存储边界拒绝普通 JSON、错误容器和未知版本，宽松构造 API 不变", () => {
  for (const value of [null, [], {}, { hello: "world" }]) {
    assert.throws(() => validateStoredStore(value), DomainError);
  }
  for (const version of [undefined, 0, 2, "1"]) {
    assert.throws(() => validateStoredStore({ ...createEmptyStore(), version }), DomainError);
  }
  for (const field of ["catalogItems", "documents", "printProfiles", "settings"]) {
    const store = createEmptyStore();
    delete store[field];
    assert.throws(() => validateStoredStore(store), DomainError, field);
  }
  assert.deepEqual(validateStoredStore(createEmptyStore()), createEmptyStore());
  assert.equal(normalizeStore({ version: 999 }).version, 1);
});

test("正数量统一解析，不把空白、零或超精度数量改成默认值", () => {
  for (const [input, expected] of [[1, 1], ["1.500", 1.5], [" 0.001 ", 0.001], [999999, 999999]]) {
    assert.equal(parsePositiveQuantity(input), expected);
  }
  for (const input of ["", " ", 0, "0.000", -1, "1.0001", 1.0001, NaN, Infinity, "Infinity", true, null, [], {}, "1e2", 1000000]) {
    assert.throws(() => parsePositiveQuantity(input), DomainError, String(input));
  }
});

test("旧版正常草稿和缺省临时项目快照可读取，补全后能够再次读取", () => {
  const store = fixture();
  store.documents[0].patientName = "";
  delete store.documents[0].lines[0].itemSnapshot.createdAt;
  delete store.documents[0].lines[0].itemSnapshot.updatedAt;
  const loaded = validateStoredStore(store);
  assert.equal(loaded.documents[0].lines[0].amountCents, 152);
  assert.deepEqual(validateStoredStore(JSON.parse(JSON.stringify(loaded))), loaded);
  const emptyDraft = createDraftDocument({ id: "empty-draft", businessDate: "2026-09-06" }, { now });
  store.documents.push(emptyDraft);
  assert.equal(validateStoredStore(store).documents.length, 2);
});

test("读取保留历史文字、完整快照和扩展字段，不改写或删除原资料", () => {
  const store = fixture();
  store.customMetadata = { importedBy: "测试导入" };
  store.documents[0].patientName = " 测试姓名 ";
  store.documents[0].note = " 第一行\n第二行 ";
  store.documents[0].lines[0].itemSnapshot.name = " 原始名称 ";
  store.documents[0].lines[0].itemSnapshot.batchHint = { value: "原始批次" };
  const before = clone(store);
  const loaded = validateStoredStore(store);
  assert.deepEqual(loaded, before);
  loaded.documents[0].lines[0].itemSnapshot.batchHint.value = "更改";
  assert.deepEqual(store, before);
});

test("逐项拒绝不可重读数量、无效价格和被篡改的明细合计", () => {
  const corruptions = [
    (s) => { s.documents[0].lines[0].quantity = 1.0001; },
    (s) => { s.documents[0].lines[0].quantity = ""; },
    (s) => { s.documents[0].lines[0].quantity = 0; },
    (s) => { s.documents[0].lines[0].unitPriceCents = "101"; },
    (s) => { s.documents[0].lines[0].unitPriceCents = -1; },
    (s) => { s.documents[0].lines[0].unitPriceCents = 1.5; },
    (s) => { s.documents[0].lines[0].amountCents += 1; },
    (s) => { s.documents[0].totalCents += 1; },
    (s) => { s.documents[0].lines[0].itemSnapshot.unitPriceCents += 1; },
    (s) => { s.catalogItems[0].unitPriceCents = NaN; },
    (s) => { s.catalogItems[0].unitPriceCents = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const corrupt of corruptions) {
    const store = fixture();
    corrupt(store);
    assert.throws(() => validateStoredStore(store), DomainError);
  }
});

test("重复主键与流水号会阻止读入，而不会静默丢弃记录", () => {
  for (const field of ["catalogItems", "documents", "printProfiles"]) {
    const store = fixture();
    store[field].push(clone(store[field][0]));
    assert.throws(() => validateStoredStore(store), /标识重复/);
  }
  const serials = fixture();
  serials.documents.push({ ...clone(serials.documents[0]), id: "another-document" });
  assert.throws(() => validateStoredStore(serials), /流水号重复/);
  const lines = fixture();
  lines.documents[0].lines.push(clone(lines.documents[0].lines[0]));
  lines.documents[0].totalCents *= 2;
  assert.throws(() => validateStoredStore(lines), /标识重复/);
});

test("错误状态、假日期和流水号日期不匹配不会被自动修复", () => {
  for (const patch of [
    { status: "unknown" }, { locked: true }, { businessDate: "2026-02-31" },
    { serial: "202609070001" }, { statisticsStartDate: "2026-02-31" },
  ]) {
    const store = fixture();
    Object.assign(store.documents[0], patch);
    assert.throws(() => validateStoredStore(store), DomainError);
  }
});

test("确认与作废单据保留金额和历史时间，缺失姓名或锁定标记时拒绝", () => {
  const store = fixture();
  store.documents[0] = confirmDocument(store.documents[0], { now });
  assert.deepEqual(validateStoredStore(store), store);
  store.documents[0] = voidDocument(store.documents[0], { now, reason: "测试作废" });
  assert.deepEqual(validateStoredStore(store), store);
  for (const patch of [{ patientName: "" }, { locked: false }, { voidReason: "" }, { confirmedAt: null }]) {
    const changed = clone(store);
    Object.assign(changed.documents[0], patch);
    assert.throws(() => validateStoredStore(changed), DomainError);
  }
});

test("打印尺寸和扩展数据中不可序列化的数字不会变成默认值或 null", () => {
  for (const patch of [{ paperWidthMm: "241" }, { paperWidthMm: 0 }, { paperHeightMm: Infinity }, { mode: "unknown" }]) {
    const store = fixture();
    Object.assign(store.printProfiles[0], patch);
    assert.throws(() => validateStoredStore(store), DomainError);
  }
  const badMargin = fixture();
  badMargin.printProfiles[0].marginsMm.left = 250;
  assert.throws(() => validateStoredStore(badMargin), /边距/);
  const invalidExtra = fixture();
  invalidExtra.customMetadata = { unexpected: Infinity };
  assert.throws(() => validateStoredStore(invalidExtra), DomainError);
  const cyclic = fixture();
  cyclic.customMetadata = cyclic;
  assert.throws(() => validateStoredStore(cyclic), DomainError);
  const unsupported = fixture();
  unsupported.customMetadata = new Date(now);
  assert.throws(() => validateStoredStore(unsupported), DomainError);
  const sparse = fixture();
  sparse.documents.length = 2;
  assert.throws(() => validateStoredStore(sparse), DomainError);
});

test("容量提醒从 80% 开始，已超过新增上限的历史仍能完整读取和导出", () => {
  assert.equal(MAX_DOCUMENTS, 20000);
  assert.equal(MAX_CATALOG_ITEMS, 10000);
  assert.deepEqual(getStoreCapacity(createEmptyStore()), { documents: 0, maxDocuments: 20000, warning: false });
  assert.equal(getStoreCapacity({ documents: Array(15999) }).warning, false);
  assert.equal(getStoreCapacity({ documents: Array(16000) }).warning, true);
  const store = createEmptyStore();
  const draft = createDraftDocument({ businessDate: "2026-09-06" }, { now });
  store.documents = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, index) => ({ ...draft, id: `document-${index}`, lines: [] }));
  const loaded = validateStoredStore(store);
  assert.equal(loaded.documents.length, MAX_DOCUMENTS + 1);
  assert.equal(JSON.parse(JSON.stringify(loaded)).documents.length, MAX_DOCUMENTS + 1);
});

test("一万张五行单据通过同一验证入口，不再受旧的节点数量限制", () => {
  const store = fixture();
  const draft = store.documents[0];
  const line = draft.lines[0];
  store.documents = Array.from({ length: 10000 }, (_, index) => ({
    ...draft,
    id: `bulk-${index}`,
    serial: "",
    lines: Array.from({ length: 5 }, (_, lineIndex) => ({ ...line, id: `line-${lineIndex}` })),
    totalCents: line.amountCents * 5,
  }));
  const loaded = validateStoredStore(store);
  assert.equal(loaded.documents.length, 10000);
  assert.equal(loaded.documents[9999].totalCents, 760);
});
