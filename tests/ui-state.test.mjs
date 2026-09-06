import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import * as domain from "../src/domain.mjs";

const appUrl = new URL("../src/app.mjs", import.meta.url);
const appSource = await readFile(appUrl, "utf8");
const startupIndex = appSource.indexOf('\n$("#recovery-import").addEventListener');
assert.ok(startupIndex > 0, "无法定位页面启动边界，需更新测试入口");
const stateSource = appSource.slice(0, startupIndex).replace(
  /^import\s*\{[\s\S]*?\}\s*from\s*"\.\/domain\.mjs";\s*/,
  "",
);
const now = "2026-09-06T10:00:00.000Z";

function makeDraft(id = "draft-1", serial = "202609060001") {
  return domain.createDraftDocument({
    id, serial, businessDate: "2026-09-06", patientName: "原始测试姓名",
    lines: [{ id: "line-1", item: { id: "item-1", name: "测试项目", unitPriceCents: 101 }, quantity: 1.5 }],
  }, { now });
}

function element() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    value: "", hidden: false, inert: false, textContent: "", dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key, value) { attributes.set(key, value); },
    getAttribute(key) { return attributes.get(key); },
    removeAttribute(key) { attributes.delete(key); },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    emit(type, event) { for (const listener of listeners.get(type) ?? []) listener(event); },
    focus() {}, close() {},
  };
}

function harness() {
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const context = vm.createContext({
    ...domain,
    JSON,
    messages: [],
    persistAttempts: 0,
    persistenceSucceeds: true,
    unsavedChoice: "cancel",
    seed: domain.createEmptyStore(),
    draftSeed: makeDraft(),
    window: { confirm: () => true },
    document: { querySelector: getElement, querySelectorAll: () => [], body: element(), addEventListener() {} },
    setTimeout: () => 0,
    clearTimeout() {},
  });
  vm.runInContext(stateSource, context, { filename: appUrl.pathname });
  vm.runInContext(`
    store = seed;
    currentDocument = draftSeed;
    showToast = (message) => messages.push(message);
    renderBilling = () => {};
    renderHistory = () => {};
    renderLocalSettings = () => {};
    renderPrintProfiles = () => {};
    updateCurrentFromInputs = () => {};
    validateBillingInputs = () => true;
    chooseUnsaved = async () => unsavedChoice;
    askVoidReason = async () => "测试作废";
    persistStore = async () => {
      validateStoredStore(store);
      persistAttempts += 1;
      return persistenceSucceeds;
    };
  `, context);
  return {
    context,
    getElement,
    evaluate: (code) => vm.runInContext(code, context),
    snapshot: () => JSON.parse(vm.runInContext("JSON.stringify({ store, currentDocument, dirty: [...dirtyAreas], lineEdits: lineEdits.size, persistAttempts, messages })", context)),
  };
}

function fillCapacity(h, firstDocument) {
  const emptyDraft = domain.createDraftDocument({ businessDate: "2026-09-06" }, { now });
  h.context.fullDocuments = Array.from({ length: domain.MAX_DOCUMENTS }, (_, index) => index === 0
    ? firstDocument
    : { ...emptyDraft, id: `bulk-${index}`, serial: "", lines: [] });
  h.evaluate("store.documents = fullDocuments;");
}

test("确认遇到重复流水号时还原草稿，不遗留确认或锁定状态", async () => {
  const h = harness();
  h.context.existing = makeDraft("existing-document");
  h.evaluate("store.documents = [existing]; dirtyAreas.add('billing');");
  const before = h.snapshot();
  await h.evaluate("confirmCurrent()");
  const after = h.snapshot();
  assert.deepEqual(after.store, before.store);
  assert.deepEqual(after.currentDocument, before.currentDocument);
  assert.equal(after.currentDocument.status, "draft");
  assert.equal(after.currentDocument.locked, false);
  assert.deepEqual(after.dirty, ["billing"]);
  assert.equal(after.persistAttempts, 0);
  assert.match(after.messages.at(-1), /流水号重复/);
});

test("确认写盘失败还原当前单据与历史，未保存标志保留", async () => {
  const h = harness();
  h.context.persistenceSucceeds = false;
  h.evaluate("dirtyAreas.add('billing');");
  const before = h.snapshot();
  await h.evaluate("confirmCurrent()");
  const after = h.snapshot();
  assert.deepEqual(after.store, before.store);
  assert.deepEqual(after.currentDocument, before.currentDocument);
  assert.deepEqual(after.dirty, ["billing"]);
  assert.equal(after.persistAttempts, 1);
});

test("达到容量上限后作废并重开被前置拒绝，原单仍已确认", async () => {
  const h = harness();
  const confirmed = domain.confirmDocument(makeDraft("confirmed-original"), { now });
  fillCapacity(h, confirmed);
  const currentBefore = h.snapshot().currentDocument;
  await assert.rejects(h.evaluate("voidRecord(store.documents[0], true)"), /容量上限/);
  assert.equal(h.evaluate("store.documents[0].status"), "confirmed");
  assert.equal(h.evaluate("store.documents.length"), domain.MAX_DOCUMENTS);
  assert.deepEqual(h.snapshot().currentDocument, currentBefore);
  assert.equal(h.evaluate("persistAttempts"), 0);
});

test("达到容量上限后按作废单重开被拒绝，不更换当前清单", async () => {
  const h = harness();
  const voided = domain.voidDocument(domain.confirmDocument(makeDraft("voided-original"), { now }), { now, reason: "测试作废" });
  fillCapacity(h, voided);
  const currentBefore = h.snapshot().currentDocument;
  await assert.rejects(h.evaluate("reopenVoided(store.documents[0])"), /容量上限/);
  assert.deepEqual(h.snapshot().currentDocument, currentBefore);
  assert.equal(h.evaluate("store.documents[0].status"), "voided");
  assert.equal(h.evaluate("persistAttempts"), 0);
});

test("作废并重开发生流水号耗尽异常时还原已修改的原单", async () => {
  const h = harness();
  h.context.original = domain.confirmDocument(makeDraft("last-serial", "202609069999"), { now });
  h.evaluate("store.documents = [original];");
  const before = h.snapshot();
  await h.evaluate("voidRecord(store.documents[0], true)");
  const after = h.snapshot();
  assert.deepEqual(after.store, before.store);
  assert.deepEqual(after.currentDocument, before.currentDocument);
  assert.equal(after.persistAttempts, 0);
  assert.match(after.messages.at(-1), /流水号已用完/);
});

test("未保存提示选择取消，保留编辑内容并阻止后续换单", async () => {
  const h = harness();
  h.evaluate("currentDocument.patientName = '未保存修改'; dirtyAreas.add('billing'); lineEdits.set('line-1', {quantity: '1.0001'});");
  const before = h.snapshot();
  assert.equal(await h.evaluate("resolveUnsaved(['billing'])"), false);
  assert.deepEqual(h.snapshot(), before);
});

test("未保存提示选择保存但写盘失败，保留当前草稿且不放行换单", async () => {
  const h = harness();
  h.context.unsavedChoice = "save";
  h.context.persistenceSucceeds = false;
  h.evaluate("currentDocument.patientName = '未保存修改'; dirtyAreas.add('billing');");
  const before = h.snapshot();
  assert.equal(await h.evaluate("resolveUnsaved(['billing'])"), false);
  const after = h.snapshot();
  assert.deepEqual(after.store, before.store);
  assert.deepEqual(after.currentDocument, before.currentDocument);
  assert.deepEqual(after.dirty, ["billing"]);
  assert.equal(after.persistAttempts, 1);
});

test("未保存提示选择放弃，恢复已存原单并清除输入缓存", async () => {
  const h = harness();
  h.context.unsavedChoice = "discard";
  h.evaluate("store.documents = [clone(currentDocument)]; currentDocument.patientName = '未保存修改'; dirtyAreas.add('billing'); lineEdits.set('line-1', {quantity: '1.0001'});");
  const saved = h.snapshot().store.documents[0];
  assert.equal(await h.evaluate("resolveUnsaved(['billing'])"), true);
  const after = h.snapshot();
  assert.deepEqual(after.currentDocument, saved);
  assert.deepEqual(after.dirty, []);
  assert.equal(after.lineEdits, 0);
  assert.equal(after.persistAttempts, 0);
});

test("未保存提示选择保存成功，保存当前草稿并清除脏标记", async () => {
  const h = harness();
  h.context.unsavedChoice = "save";
  h.evaluate("currentDocument.patientName = '待保存修改'; dirtyAreas.add('billing');");
  assert.equal(await h.evaluate("resolveUnsaved(['billing'])"), true);
  const after = h.snapshot();
  assert.equal(after.store.documents[0].patientName, "待保存修改");
  assert.deepEqual(after.dirty, []);
  assert.equal(after.persistAttempts, 1);
});

test("保存任务未完成时排斥重复操作，完成后解除界面锁定", async () => {
  const h = harness();
  let release;
  h.context.barrier = new Promise((resolve) => { release = resolve; });
  const pending = h.evaluate("runExclusive(() => barrier)");
  assert.equal(h.getElement(".app-shell").inert, true);
  assert.equal(await h.evaluate("runExclusive(() => { throw new Error('重复操作不应执行'); })"), false);
  release(true);
  assert.equal(await pending, true);
  assert.equal(h.evaluate("operationPromise"), null);
  assert.equal(h.getElement(".app-shell").inert, false);
});

test("操作异常后释放互斥与界面锁定，未保存内容仍显示为待保存", async () => {
  const h = harness();
  h.evaluate("dirtyAreas.add('billing');");
  assert.equal(await h.evaluate("runExclusive(() => { throw new Error('模拟操作失败'); })"), false);
  assert.equal(h.evaluate("operationPromise"), null);
  assert.equal(h.getElement(".app-shell").inert, false);
  assert.equal(h.getElement("#save-state").textContent, "有未保存更改");
  assert.deepEqual(h.snapshot().dirty, ["billing"]);
});

test("点击明细输入框不锁定界面，点击删除按钮才进入互斥并删除该行", async () => {
  const h = harness();
  h.evaluate("renderLines = () => {}; bindEvents();");
  h.getElement("#line-items").emit("click", { target: { closest: () => null } });
  assert.equal(h.evaluate("operationPromise"), null);
  assert.equal(h.getElement(".app-shell").inert, false);
  assert.equal(h.snapshot().currentDocument.lines.length, 1);

  const removeButton = { closest: () => ({ dataset: { lineId: "line-1" } }) };
  h.getElement("#line-items").emit("click", { target: { closest: () => removeButton } });
  assert.equal(h.getElement(".app-shell").inert, true);
  await h.evaluate("operationPromise");
  assert.equal(h.snapshot().currentDocument.lines.length, 0);
  assert.deepEqual(h.snapshot().dirty, ["billing"]);
  assert.equal(h.getElement(".app-shell").inert, false);
});
