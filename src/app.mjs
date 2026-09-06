import {
  DEFAULT_PRINT_PROFILES,
  createEmptyStore,
  validateStoredStore,
  parsePositiveQuantity,
  getStoreCapacity,
  MAX_DOCUMENTS,
  MAX_CATALOG_ITEMS,
  createId,
  parseMoneyToCents,
  formatMoney,
  calculateLineAmount,
  toChineseUppercase,
  nextSerial,
  createDraftDocument,
  validateDocument,
  confirmDocument,
  voidDocument,
  copyAsDraft,
  matchesDocument,
} from "./domain.mjs";

const STORAGE_KEY = "clinic-desktop-mvp:v1";
const pages = {
  billing: { title: "收费开单", subtitle: "录入项目、核对金额并打印内部明细清单", code: "BILLING 01" },
  history: { title: "历史单据", subtitle: "按姓名、日期与内部流水号组合查询", code: "RECORDS 02" },
  catalog: { title: "项目目录", subtitle: "维护常用项目的名称、价格、单位与使用状态", code: "CATALOG 03" },
  printing: { title: "打印设置", subtitle: "维护两套纸型档案与点阵打印偏移量", code: "PRINTING 04" },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const todayIso = () => {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

let store;
let currentDocument;
let currentView = "billing";
let activeHistoryId = null;
let previewDocument = null;
let toastTimer = null;
let storageProtection = "browser";
let operationPromise = null;
let historyPage = 1;
let previewProfile = null;
const HISTORY_PAGE_SIZE = 50;
const dirtyAreas = new Set();
const lineEdits = new Map();
let eventsBound = false;
let clockTimer = null;

function markDirty(area, dirty = true) {
  if (dirty) dirtyAreas.add(area);
  else dirtyAreas.delete(area);
  if (!operationPromise && $("#save-state")) $("#save-state").textContent = dirtyAreas.size ? "有未保存更改" : "已保存";
  window.clinicDesktop?.setDirty?.(dirtyAreas.size > 0).catch(() => {});
}

function runExclusive(action) {
  if (operationPromise) return Promise.resolve(false);
  const roots = [$(".app-shell"), ...$$("dialog[open]")].filter(Boolean);
  roots.forEach((root) => { root.inert = true; });
  document.body.setAttribute("aria-busy", "true");
  operationPromise = Promise.resolve().then(action).catch((error) => {
    showToast(error?.message || "操作未完成，请重试", true);
    return false;
  }).finally(() => {
    roots.forEach((root) => { root.inert = false; });
    document.body.removeAttribute("aria-busy");
    operationPromise = null;
    if ($("#save-state")) $("#save-state").textContent = dirtyAreas.size ? "有未保存更改" : "已保存";
  });
  return operationPromise;
}

function chooseUnsaved() {
  const dialog = $("#unsaved-dialog");
  return new Promise((resolve) => {
    const finish = (choice) => {
      dialog.removeEventListener("click", click);
      dialog.removeEventListener("cancel", cancel);
      dialog.close();
      resolve(choice);
    };
    const click = (event) => {
      const choice = event.target.closest("[data-unsaved-choice]")?.dataset.unsavedChoice;
      if (choice) finish(choice);
    };
    const cancel = (event) => { event.preventDefault(); finish("cancel"); };
    dialog.addEventListener("click", click);
    dialog.addEventListener("cancel", cancel);
    dialog.showModal();
  });
}

async function resolveUnsaved(areas = [...dirtyAreas]) {
  const pending = areas.filter((area) => dirtyAreas.has(area));
  if (!pending.length) return true;
  const choice = await chooseUnsaved();
  if (choice === "cancel") return false;
  if (choice === "save") {
    if (pending.includes("billing") && !(await saveDraft())) return false;
    if (pending.includes("settings") && !(await savePrintSettings())) return false;
    if (pending.includes("catalog") && !(await submitCatalog())) return false;
  } else {
    if (pending.includes("billing")) {
      const saved = store.documents.find((doc) => doc.id === currentDocument.id);
      selectDocument(saved ? clone(saved) : createFreshDocument());
    }
    if (pending.includes("settings")) { renderLocalSettings(); renderPrintProfiles(); }
    if (pending.includes("catalog")) $("#catalog-dialog").close();
    for (const area of pending) markDirty(area, false);
  }
  return true;
}

function selectDocument(doc) {
  currentDocument = doc;
  lineEdits.clear();
  markDirty("billing", false);
  $("#billing-error").hidden = true;
  renderBilling();
}

function updateCapacity() {
  const capacity = getStoreCapacity(store);
  const warning = $("#capacity-warning");
  warning.hidden = !capacity.warning;
  warning.textContent = `本机已有 ${capacity.documents} 张单据，接近本版 ${capacity.maxDocuments} 张的支持上限。请导出备份并联系维护者扩容；已有记录仍可查询和导出。`;
}

function moneyText(cents) {
  try {
    const value = formatMoney(Number(cents) || 0);
    return String(value).startsWith("¥") ? String(value) : `¥${value}`;
  } catch {
    return `¥${((Number(cents) || 0) / 100).toFixed(2)}`;
  }
}

function moneyInputText(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

function parseCents(value) {
  const cents = parseMoneyToCents(String(value ?? ""));
  if (cents < 0) throw new Error("单价不能为负数");
  return cents;
}

function lineAmount(line) {
  return calculateLineAmount(line.unitPriceCents, line.quantity);
}

function uppercaseText(cents) {
  try { return toChineseUppercase(Number(cents) || 0); }
  catch { return cents ? "金额大写转换失败" : "零元整"; }
}

function statusText(status) {
  return ({ draft: "草稿", confirmed: "已确认", voided: "已作废" })[status] || "草稿";
}

function statusClass(status) {
  return ({ draft: "status-draft", confirmed: "status-confirmed", voided: "status-void" })[status] || "status-draft";
}

function displayItemName(item = {}) {
  return [item.name, item.specification].filter(Boolean).join(" ");
}

function makeSerial(date = todayIso()) {
  return nextSerial(store.documents, date);
}

function defaultProfileId() {
  return store.settings?.defaultPrintProfileId
    || store.printProfiles.find((profile) => profile.isDefault)?.id
    || store.printProfiles[0]?.id
    || "blank-241x140";
}

function createFreshDocument(source = {}) {
  const businessDate = source.businessDate || todayIso();
  const input = {
    serial: source.serial || makeSerial(businessDate),
    patientName: source.patientName || "",
    businessDate,
    patientType: source.patientType || "自费",
    operatorName: source.operatorName || store.settings?.defaultOperator || "收费员",
    organizationName: source.organizationName || store.settings?.organizationName || "",
    doctorName: source.doctorName || "",
    statisticsStartDate: source.statisticsStartDate || businessDate,
    statisticsEndDate: source.statisticsEndDate || businessDate,
    lines: source.lines || [],
    note: source.note || "",
    printProfileId: source.printProfileId || defaultProfileId(),
  };
  try {
    const documentValue = createDraftDocument(input, { now: nowIso(), idFactory: createId });
    return {
      patientType: input.patientType,
      operatorName: input.operatorName,
      organizationName: input.organizationName,
      doctorName: input.doctorName,
      statisticsStartDate: input.statisticsStartDate,
      statisticsEndDate: input.statisticsEndDate,
      ...documentValue,
    };
  } catch {
    return {
      id: createId("doc"), serial: input.serial, status: "draft", locked: false,
      patientName: input.patientName, patientType: input.patientType, operatorName: input.operatorName,
      organizationName: input.organizationName, doctorName: input.doctorName,
      statisticsStartDate: input.statisticsStartDate, statisticsEndDate: input.statisticsEndDate,
      businessDate, lines: [], totalCents: 0, note: input.note,
      printProfileId: input.printProfileId, createdAt: nowIso(), updatedAt: nowIso(),
    };
  }
}

function defaultProfiles() {
  const base = clone(DEFAULT_PRINT_PROFILES || []);
  if (base.length) return base;
  return [
    { id: "blank-241x140", name: "空白纸完整打印", mode: "blank", paperWidthMm: 241, paperHeightMm: 140, marginsMm: { top: 0, right: 15.5, bottom: 0, left: 15.5 }, offsetMm: { x: 0, y: 0 }, isDefault: true },
    { id: "preprinted-90x90", name: "预印票据套打", mode: "preprinted", paperWidthMm: 90, paperHeightMm: 90, marginsMm: { top: 3, right: 3, bottom: 3, left: 3 }, offsetMm: { x: 0, y: 0 }, isDefault: false },
  ];
}

function normalizeLoaded(raw) {
  let value = raw;
  if (value && typeof value === "object" && "data" in value) {
    storageProtection = value.storageProtection || "plain";
    value = value.data;
  }
  const normalized = value == null ? createEmptyStore() : validateStoredStore(value);
  if (!normalized.printProfiles?.length) normalized.printProfiles = defaultProfiles();
  return normalized;
}

async function loadStore() {
  if (window.clinicDesktop?.loadData) {
    try {
      const result = await window.clinicDesktop.loadData();
      store = normalizeLoaded(result);
      setStorageLabel(storageProtection);
      return;
    } catch (error) {
      console.error("Desktop storage unavailable.", error);
      throw new Error("无法读取本机收费数据。为避免覆盖原文件，程序已停止进入编辑状态；请先恢复备份或检查数据目录。", { cause: error });
    }
  }
  try {
    store = normalizeLoaded(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"));
  } catch {
    throw new Error("浏览器草稿无法读取，请恢复备份；原数据已保留。");
  }
  storageProtection = "browser";
  setStorageLabel("browser");
}

async function persistStore(message = "已保存到本机") {
  $("#save-state").textContent = "保存中…";
  try {
    const snapshot = validateStoredStore(store);
    if (window.clinicDesktop?.saveData) {
      await window.clinicDesktop.saveData(snapshot);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    }
    $("#save-state").textContent = "已同步";
    if (message) showToast(message);
    updateCapacity();
    return true;
  } catch (error) {
    console.error(error);
    $("#save-state").textContent = "保存失败";
    showToast(error?.message || "保存失败，请稍后重试", true);
    return false;
  }
}

function setStorageLabel(mode) {
  const labels = {
    "desktop-encrypted": "Windows 用户级加密",
    "encrypted-v1": "Windows 用户级加密",
    plain: "仅本机明文存储",
    "plain-v1": "仅本机明文存储",
    browser: "浏览器本机明文",
  };
  $("#storage-mode").textContent = labels[mode] || "仅本机存储";
}

function showToast(message, error = false) {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("is-error", error);
  toast.hidden = false;
  $("#live-region").textContent = message;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
    toast.textContent = "";
  }, 2600);
}

function switchView(name) {
  if (!pages[name]) return;
  currentView = name;
  $$("[data-view-panel]").forEach((panel) => panel.classList.toggle("is-visible", panel.dataset.viewPanel === name));
  $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === name));
  $("#page-title").textContent = pages[name].title;
  $("#page-subtitle").textContent = pages[name].subtitle;
  $("#page-code").textContent = pages[name].code;
  if (name === "history") renderHistory();
  if (name === "catalog") renderCatalog();
  if (name === "printing") {
    renderLocalSettings();
    renderPrintProfiles();
  }
}

function renderLocalSettings() {
  $("#settings-organization").value = store.settings?.organizationName || "";
  $("#settings-operator").value = store.settings?.defaultOperator || "收费员";
}

function upsertDocument(documentValue) {
  const index = store.documents.findIndex((item) => item.id === documentValue.id);
  if (index < 0 && store.documents.length >= MAX_DOCUMENTS) throw new Error("单据已达到本版支持上限，请先导出备份并联系维护者扩容。");
  if (store.documents.some((item) => item.id !== documentValue.id && item.serial === documentValue.serial)) throw new Error("流水号重复，请重新新建清单。");
  if (index >= 0) store.documents[index] = clone(documentValue);
  else store.documents.unshift(clone(documentValue));
}

function updateCurrentFromInputs() {
  if (!currentDocument || currentDocument.locked) return;
  currentDocument.patientName = $("#patient-name").value.trim();
  currentDocument.businessDate = $("#charge-date").value || todayIso();
  const serialPrefix = currentDocument.businessDate.replaceAll("-", "");
  if (!String(currentDocument.serial || "").startsWith(serialPrefix)) {
    currentDocument.serial = makeSerial(currentDocument.businessDate);
    $("#document-serial").textContent = currentDocument.serial;
  }
  currentDocument.patientType = $("#patient-type").value;
  currentDocument.operatorName = $("#operator-name").value.trim() || "收费员";
  currentDocument.organizationName = $("#medical-institution").value.trim();
  currentDocument.doctorName = $("#doctor-name").value.trim();
  currentDocument.statisticsStartDate = $("#statistics-from").value;
  currentDocument.statisticsEndDate = $("#statistics-to").value;
  currentDocument.note = $("#document-note").value.trim();
  currentDocument.printProfileId = $("#billing-profile").value || defaultProfileId();
  currentDocument.totalCents = currentDocument.lines.reduce((sum, line) => sum + lineAmount(line), 0);
  currentDocument.updatedAt = nowIso();
  $("#sidebar-operator").textContent = currentDocument.operatorName;
}

function renderBilling() {
  const doc = currentDocument;
  const locked = Boolean(doc.locked || doc.status !== "draft");
  $("#patient-name").value = doc.patientName || "";
  $("#charge-date").value = doc.businessDate || todayIso();
  $("#patient-type").value = doc.patientType || "自费";
  $("#operator-name").value = doc.operatorName || "收费员";
  $("#medical-institution").value = doc.organizationName || "";
  $("#doctor-name").value = doc.doctorName || "";
  $("#statistics-from").value = doc.statisticsStartDate || doc.businessDate || "";
  $("#statistics-to").value = doc.statisticsEndDate || doc.businessDate || "";
  $("#document-note").value = doc.note || "";
  $("#document-serial").textContent = doc.serial || "待确认后生成";
  const badge = $("#document-status");
  badge.textContent = statusText(doc.status);
  badge.className = `status-badge ${statusClass(doc.status)}`;
  $("#locked-mask").hidden = !locked;
  $$("#heading-fields input, #heading-fields select, #document-note").forEach((control) => { control.disabled = locked; });
  $("#add-catalog-line").disabled = locked;
  $("#add-temp-line").disabled = locked;
  $("#save-draft").disabled = locked;
  $("#confirm-document").disabled = locked;
  renderProfileSelect();
  renderLines();
  renderPalette();
}

function renderProfileSelect() {
  const select = $("#billing-profile");
  select.innerHTML = store.printProfiles.map((profile) => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)}</option>`).join("");
  select.value = currentDocument.printProfileId || defaultProfileId();
  if (!select.value && store.printProfiles[0]) select.value = store.printProfiles[0].id;
}

function renderLines() {
  const tbody = $("#line-items");
  const locked = Boolean(currentDocument.locked || currentDocument.status !== "draft");
  currentDocument.lines = (currentDocument.lines || []).map((line) => ({ ...line, amountCents: lineAmount(line) }));
  currentDocument.totalCents = currentDocument.lines.reduce((sum, line) => sum + line.amountCents, 0);
  tbody.innerHTML = currentDocument.lines.map((line, index) => {
    const item = line.itemSnapshot || {};
    const edits = lineEdits.get(line.id);
    return `<tr data-line-id="${escapeHtml(line.id)}">
      <td class="row-num">${String(index + 1).padStart(2, "0")}</td>
      <td><input class="name-input" data-field="name" value="${escapeHtml(displayItemName(item))}" aria-label="第${index + 1}项名称及规格" ${locked ? "disabled" : ""}></td>
      <td><input class="money-input" data-field="unitPrice" inputmode="decimal" value="${escapeHtml(edits?.price ?? moneyInputText(line.unitPriceCents))}" aria-label="第${index + 1}项单价" ${locked ? "disabled" : ""}></td>
      <td><input class="qty-input" data-field="quantity" inputmode="decimal" value="${escapeHtml(edits?.quantity ?? line.quantity ?? 1)}" aria-label="第${index + 1}项数量" ${locked ? "disabled" : ""}></td>
      <td><input class="unit-input" data-field="unit" value="${escapeHtml(item.unit || "次")}" maxlength="8" aria-label="第${index + 1}项单位" ${locked ? "disabled" : ""}></td>
      <td class="line-amount">${moneyText(line.amountCents)}</td>
      <td><button class="remove-line" type="button" title="删除此项" aria-label="删除第${index + 1}项" ${locked ? "disabled" : ""}>×</button></td>
    </tr>`;
  }).join("");
  $("#lines-empty").hidden = currentDocument.lines.length > 0;
  $("#line-count").textContent = `${currentDocument.lines.length} 项`;
  $("#total-amount").textContent = moneyText(currentDocument.totalCents);
  $("#total-uppercase").textContent = uppercaseText(currentDocument.totalCents);
  if (!locked) $$("#line-items tr").forEach((row) => mutateLineFromRow(row, false));
}

function validateNumberControl(control, parser) {
  try {
    const value = parser(control.value);
    control.setCustomValidity("");
    control.removeAttribute("aria-invalid");
    control.removeAttribute("title");
    return { valid: true, value };
  } catch (error) {
    control.setCustomValidity(error.message);
    control.setAttribute("aria-invalid", "true");
    control.title = error.message;
    return { valid: false };
  }
}

function validateBillingInputs() {
  $$("#line-items tr").forEach((row) => mutateLineFromRow(row, false));
  const invalid = $("#line-items [aria-invalid='true']");
  const error = $("#billing-error");
  error.hidden = !invalid;
  if (invalid) {
    error.textContent = `${invalid.getAttribute("aria-label")}：${invalid.validationMessage}`;
    setTimeout(() => { invalid.focus(); invalid.reportValidity(); }, 0);
    showToast("请先修正单价或数量，再保存或打印", true);
    return false;
  }
  return true;
}

function mutateLineFromRow(row, changed = true) {
  if (currentDocument.locked) return;
  const line = currentDocument.lines.find((item) => item.id === row.dataset.lineId);
  if (!line) return;
  if (changed) markDirty("billing");
  const nameAndSpec = $("[data-field='name']", row).value.trim();
  const priceControl = $("[data-field='unitPrice']", row);
  const quantityControl = $("[data-field='quantity']", row);
  lineEdits.set(line.id, { price: priceControl.value, quantity: quantityControl.value });
  const price = validateNumberControl(priceControl, parseCents);
  const quantity = validateNumberControl(quantityControl, parsePositiveQuantity);
  const unit = $("[data-field='unit']", row).value.trim() || "次";
  if (changed) {
    if (nameAndSpec !== displayItemName(line.itemSnapshot)) {
      line.itemSnapshot = { ...line.itemSnapshot, name: nameAndSpec, specification: "" };
    }
    line.itemSnapshot.unit = unit;
  }
  if (!price.valid || !quantity.valid) {
    $(".line-amount", row).textContent = "请检查输入";
    $("#total-amount").textContent = "—";
    $("#total-uppercase").textContent = "请修正单价或数量";
    return;
  }
  let amount;
  try { amount = calculateLineAmount(price.value, quantity.value); }
  catch (error) {
    quantityControl.setCustomValidity(error.message);
    quantityControl.setAttribute("aria-invalid", "true");
    $(".line-amount", row).textContent = "金额超出范围";
    $("#total-amount").textContent = "—";
    $("#total-uppercase").textContent = "请修正单价或数量";
    return;
  }
  line.itemSnapshot.unitPriceCents = price.value;
  line.unitPriceCents = price.value;
  line.quantity = quantity.value;
  line.amountCents = amount;
  currentDocument.totalCents = currentDocument.lines.reduce((sum, item) => sum + item.amountCents, 0);
  $(".line-amount", row).textContent = moneyText(line.amountCents);
  const hasInvalid = Boolean($("#line-items [aria-invalid='true']"));
  $("#total-amount").textContent = hasInvalid ? "—" : moneyText(currentDocument.totalCents);
  $("#total-uppercase").textContent = hasInvalid ? "请修正单价或数量" : uppercaseText(currentDocument.totalCents);
  if (!hasInvalid) $("#billing-error").hidden = true;
  if (changed) currentDocument.updatedAt = nowIso();
}

function itemToLine(item) {
  const line = {
    id: createId("line"), catalogItemId: item.id || null, itemSnapshot: clone(item),
    quantity: 1, unitPriceCents: Number(item.unitPriceCents) || 0,
  };
  line.amountCents = lineAmount(line);
  return line;
}

function addCatalogItem(item) {
  if (currentDocument.locked) return;
  currentDocument.lines.push(itemToLine(item));
  currentDocument.updatedAt = nowIso();
  markDirty("billing");
  renderLines();
  showToast(`已添加：${item.name}`);
}

function addTemporaryItem() {
  if (currentDocument.locked) return;
  const item = { id: createId("temp-item"), code: "TEMP", name: "临时项目", specification: "", unit: "次", unitPriceCents: 0, enabled: true };
  currentDocument.lines.push(itemToLine(item));
  markDirty("billing");
  renderLines();
  const lastRow = $("#line-items tr:last-child");
  $("[data-field='name']", lastRow)?.select();
}

function activeCatalogItems(search = "") {
  const needle = search.trim().toLocaleLowerCase("zh-CN");
  return store.catalogItems
    .filter((item) => item.enabled !== false)
    .filter((item) => !needle || `${item.code} ${item.name} ${item.specification || ""}`.toLocaleLowerCase("zh-CN").includes(needle));
}

function renderPalette() {
  const items = activeCatalogItems($("#palette-search").value);
  $("#active-catalog-count").textContent = store.catalogItems.filter((item) => item.enabled !== false).length;
  $("#palette-list").innerHTML = items.length ? items.map((item) => `<button class="palette-item" type="button" data-item-id="${escapeHtml(item.id)}">
    <span><strong>${escapeHtml(item.name)}</strong><b>${moneyText(item.unitPriceCents)}</b></span>
    <small>${escapeHtml(item.code)} · ${escapeHtml(item.specification || item.unit || "未设规格")}</small>
  </button>`).join("") : `<div class="palette-empty">没有找到启用中的项目</div>`;
}

function renderPicker() {
  const items = activeCatalogItems($("#picker-search").value);
  $("#picker-list").innerHTML = items.length ? items.map((item) => `<button class="picker-row" type="button" data-item-id="${escapeHtml(item.id)}">
    <code>${escapeHtml(item.code)}</code><span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.specification || `单位：${item.unit}`)}</small></span><b>${moneyText(item.unitPriceCents)}</b>
  </button>`).join("") : `<div class="empty-state"><strong>没有匹配项目</strong><p>可以关闭窗口后新增临时项目。</p></div>`;
}

async function saveDraft() {
  if (!currentDocument || currentDocument.locked) return !dirtyAreas.has("billing");
  if (!validateBillingInputs()) return false;
  updateCurrentFromInputs();
  const previousDocuments = clone(store.documents);
  upsertDocument(currentDocument);
  if (!(await persistStore("草稿已保存到本机"))) {
    store.documents = previousDocuments;
    return false;
  }
  markDirty("billing", false);
  return true;
}

async function confirmCurrent() {
  if (currentDocument.locked || !validateBillingInputs()) return false;
  updateCurrentFromInputs();
  if (!currentDocument.serial) currentDocument.serial = makeSerial(currentDocument.businessDate);
  const result = validateDocument(currentDocument);
  if (!result.valid) {
    const message = result.errors?.[0]?.message || "请补全姓名并至少录入一个有效项目";
    showToast(message, true);
    const path = result.errors?.[0]?.path || "";
    if (path.includes("patient")) $("#patient-name").focus();
    else if (!currentDocument.lines.length) $("#add-catalog-line").focus();
    return;
  }
  if (!window.confirm(`确认清单 ${currentDocument.serial}？\n确认后内容将锁定，修改需作废重开。`)) return;
  const previousDocument = clone(currentDocument);
  const previousDocuments = clone(store.documents);
  try {
    currentDocument = confirmDocument(currentDocument, { now: nowIso(), confirmedBy: currentDocument.operatorName || "收费员" });
    upsertDocument(currentDocument);
    if (!(await persistStore("清单已确认并锁定"))) {
      currentDocument = previousDocument;
      store.documents = previousDocuments;
      renderBilling();
      return;
    }
    markDirty("billing", false);
    renderBilling();
    return true;
  } catch (error) {
    currentDocument = previousDocument;
    store.documents = previousDocuments;
    renderBilling();
    showToast(error?.message || "确认失败，请检查清单内容", true);
  }
}

function readHistoryFilters() {
  return {
    name: $("#filter-name").value.trim(),
    dateFrom: $("#filter-from").value,
    dateTo: $("#filter-to").value,
    serial: $("#filter-serial").value.trim(),
  };
}

function documentMatches(doc, filters) {
  try { return matchesDocument(doc, filters); }
  catch {
    return (!filters.name || String(doc.patientName || "").includes(filters.name))
      && (!filters.dateFrom || doc.businessDate >= filters.dateFrom)
      && (!filters.dateTo || doc.businessDate <= filters.dateTo)
      && (!filters.serial || String(doc.serial || "").includes(filters.serial));
  }
}

function renderHistory() {
  const filters = readHistoryFilters();
  const documents = [...store.documents]
    .filter((doc) => documentMatches(doc, filters))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  $("#history-count").textContent = `${documents.length} 条记录`;
  const pageCount = Math.max(1, Math.ceil(documents.length / HISTORY_PAGE_SIZE));
  historyPage = Math.max(1, Math.min(historyPage, pageCount));
  $("#history-page").textContent = `第 ${historyPage} / ${pageCount} 页，每页 ${HISTORY_PAGE_SIZE} 条`;
  $("#history-prev").disabled = historyPage === 1;
  $("#history-next").disabled = historyPage === pageCount;
  $("#history-rows").innerHTML = documents.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE).map((doc) => `<tr>
    <td class="serial">${escapeHtml(doc.serial || "—")}</td>
    <td class="date-cell">${escapeHtml(doc.businessDate || "—")}</td>
    <td>${escapeHtml(doc.patientName || "未填写")}</td>
    <td>${doc.lines?.length || 0}</td>
    <td class="money-cell">${moneyText(doc.totalCents)}</td>
    <td><span class="status-badge ${statusClass(doc.status)}">${statusText(doc.status)}</span></td>
    <td><button class="table-action" type="button" data-history-action="view" data-id="${escapeHtml(doc.id)}">查看</button>${doc.status === "draft" ? `<button class="table-action" type="button" data-history-action="edit" data-id="${escapeHtml(doc.id)}">继续录入</button>` : `<button class="table-action" type="button" data-history-action="print" data-id="${escapeHtml(doc.id)}">补打</button>`}</td>
  </tr>`).join("");
  $("#history-empty").hidden = documents.length > 0;
}

function renderHistoryDetail(doc) {
  activeHistoryId = doc.id;
  $("#history-detail").innerHTML = `<div class="detail-heading">
    <div><span>内部流水号</span><strong>${escapeHtml(doc.serial || "—")}</strong></div>
    <div><span>收费日期</span><strong>${escapeHtml(doc.businessDate || "—")}</strong></div>
    <div><span>姓名</span><strong>${escapeHtml(doc.patientName || "未填写")}</strong></div>
    <div><span>状态</span><strong>${statusText(doc.status)}</strong></div>
    <div><span>医疗机构</span><strong>${escapeHtml(doc.organizationName || "—")}</strong></div>
    <div><span>开具医生</span><strong>${escapeHtml(doc.doctorName || "—")}</strong></div>
    <div><span>统计开始</span><strong>${escapeHtml(doc.statisticsStartDate || "—")}</strong></div>
    <div><span>统计结束</span><strong>${escapeHtml(doc.statisticsEndDate || "—")}</strong></div>
  </div><div class="detail-lines"><table class="data-table"><thead><tr><th>项目 / 规格 / 类别</th><th>单价</th><th>数量</th><th>单位</th><th>金额</th></tr></thead><tbody>
    ${(doc.lines || []).map((line) => `<tr><td><strong>${escapeHtml(displayItemName(line.itemSnapshot))}</strong><small class="block-muted">${escapeHtml(line.itemSnapshot?.category || "未分类")} · 票据汇总：${escapeHtml(line.itemSnapshot?.summaryCategory || "未分类")}</small></td><td class="money-cell">${moneyText(line.unitPriceCents)}</td><td>${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.itemSnapshot?.unit || "次")}</td><td class="money-cell">${moneyText(lineAmount(line))}</td></tr>`).join("")}
  </tbody></table></div><div class="detail-total"><span>合计人民币（大写） ${escapeHtml(uppercaseText(doc.totalCents))}</span><strong>${moneyText(doc.totalCents)}</strong></div>`;
  let actions = `<button class="button" type="button" data-modal-action="print">补打清单</button>`;
  if (doc.status === "confirmed") actions += `<button class="button button-danger" type="button" data-modal-action="void">作废</button><button class="button button-dark" type="button" data-modal-action="void-reopen">作废并重开</button>`;
  if (doc.status === "voided") actions += `<button class="button button-dark" type="button" data-modal-action="reopen">按此单重开</button>`;
  if (doc.status === "draft") actions += `<button class="button button-dark" type="button" data-modal-action="edit">继续录入</button>`;
  $("#history-actions").innerHTML = `<span></span><div>${actions}</div>`;
}

function askVoidReason() {
  const dialog = $("#void-dialog");
  const form = $("#void-form");
  $("#void-reason").value = "录入有误";
  return new Promise((resolve) => {
    const finish = (value) => {
      form.removeEventListener("submit", submit);
      dialog.removeEventListener("cancel", cancel);
      $("#cancel-void").removeEventListener("click", cancel);
      dialog.close();
      resolve(value);
    };
    const submit = (event) => {
      event.preventDefault();
      const value = $("#void-reason").value.trim();
      if (value) finish(value);
    };
    const cancel = (event) => { event.preventDefault(); finish(null); };
    form.addEventListener("submit", submit);
    dialog.addEventListener("cancel", cancel);
    $("#cancel-void").addEventListener("click", cancel);
    dialog.showModal();
  });
}

async function voidRecord(doc, reopenAfter = false) {
  if (reopenAfter && store.documents.length >= MAX_DOCUMENTS) throw new Error("单据已达到容量上限，请先导出备份并联系维护者；原单未作废。");
  if (reopenAfter && !(await resolveUnsaved(["billing"]))) return false;
  const reason = await askVoidReason();
  if (reason === null) return;
  if (!reason.trim()) { showToast("请填写作废原因", true); return; }
  const previousDocuments = clone(store.documents);
  const previousCurrentDocument = clone(currentDocument);
  try {
    const voided = voidDocument(doc, { now: nowIso(), voidedBy: currentDocument?.operatorName || "收费员", reason: reason.trim() });
    upsertDocument(voided);
    if (reopenAfter) {
      const serial = makeSerial(voided.businessDate || todayIso());
      currentDocument = copyAsDraft(voided, { serial, now: nowIso(), idFactory: createId });
      currentDocument.patientType = voided.patientType || "自费";
      currentDocument.operatorName = voided.operatorName || "收费员";
      currentDocument.organizationName = voided.organizationName || "";
      currentDocument.doctorName = voided.doctorName || "";
      currentDocument.statisticsStartDate = voided.statisticsStartDate || voided.businessDate;
      currentDocument.statisticsEndDate = voided.statisticsEndDate || voided.businessDate;
      upsertDocument(currentDocument);
    }
    if (!(await persistStore(reopenAfter ? "原单已作废，已生成新草稿" : "单据已作废"))) {
      store.documents = previousDocuments;
      currentDocument = previousCurrentDocument;
      return;
    }
    if (!reopenAfter && currentDocument.id === voided.id) currentDocument = clone(voided);
    if (reopenAfter || currentDocument.id === voided.id) {
      lineEdits.clear();
      markDirty("billing", false);
      renderBilling();
    }
    $("#history-dialog").close();
    if (reopenAfter) { renderBilling(); switchView("billing"); }
    else renderHistory();
  } catch (error) {
    store.documents = previousDocuments;
    currentDocument = previousCurrentDocument;
    renderBilling();
    showToast(error?.message || "作废失败", true);
  }
}

async function reopenVoided(doc) {
  if (store.documents.length >= MAX_DOCUMENTS) throw new Error("单据已达到容量上限，请先导出备份并联系维护者。");
  if (!(await resolveUnsaved(["billing"]))) return false;
  const previousDocuments = clone(store.documents);
  const previousCurrentDocument = clone(currentDocument);
  try {
    currentDocument = copyAsDraft(doc, { serial: makeSerial(doc.businessDate || todayIso()), now: nowIso(), idFactory: createId });
    currentDocument.patientType = doc.patientType || "自费";
    currentDocument.operatorName = doc.operatorName || "收费员";
    currentDocument.organizationName = doc.organizationName || "";
    currentDocument.doctorName = doc.doctorName || "";
    currentDocument.statisticsStartDate = doc.statisticsStartDate || doc.businessDate;
    currentDocument.statisticsEndDate = doc.statisticsEndDate || doc.businessDate;
    upsertDocument(currentDocument);
    if (!(await persistStore("已按原单生成新草稿"))) {
      store.documents = previousDocuments;
      currentDocument = previousCurrentDocument;
      return;
    }
    $("#history-dialog").close();
    markDirty("billing", false);
    lineEdits.clear();
    renderBilling();
    switchView("billing");
  } catch (error) {
    store.documents = previousDocuments;
    currentDocument = previousCurrentDocument;
    renderBilling();
    showToast(error?.message || "重开失败", true);
  }
}

function filteredCatalog() {
  const needle = $("#catalog-search").value.trim().toLocaleLowerCase("zh-CN");
  return [...store.catalogItems]
    .filter((item) => !needle || `${item.code} ${item.name} ${item.specification || ""}`.toLocaleLowerCase("zh-CN").includes(needle))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || String(a.code).localeCompare(String(b.code)));
}

function renderCatalog() {
  const items = filteredCatalog();
  const active = store.catalogItems.filter((item) => item.enabled !== false).length;
  $("#catalog-total").textContent = store.catalogItems.length;
  $("#catalog-active").textContent = active;
  $("#catalog-inactive").textContent = store.catalogItems.length - active;
  $("#catalog-rows").innerHTML = items.map((item) => `<tr>
    <td class="code-cell">${escapeHtml(item.code)}</td>
    <td><strong>${escapeHtml(item.name)}</strong>${item.specification ? `<small class="block-muted">规格：${escapeHtml(item.specification)}</small>` : ""}<small class="block-muted">项目类别：${escapeHtml(item.category || "未分类")} · 票据汇总：${escapeHtml(item.summaryCategory || "未分类")}</small></td>
    <td class="money-cell">${moneyText(item.unitPriceCents)}</td><td>${escapeHtml(item.unit || "次")}</td>
    <td><span class="state-pill ${item.enabled !== false ? "state-active" : "state-inactive"}">${item.enabled !== false ? "启用" : "停用"}</span></td>
    <td class="date-cell">${escapeHtml(String(item.updatedAt || item.createdAt || "—").slice(0, 10))}</td>
    <td><button class="table-action" type="button" data-catalog-action="edit" data-id="${escapeHtml(item.id)}">编辑</button><button class="table-action" type="button" data-catalog-action="toggle" data-id="${escapeHtml(item.id)}">${item.enabled !== false ? "停用" : "启用"}</button><button class="table-action" type="button" data-catalog-action="delete" data-id="${escapeHtml(item.id)}">删除</button></td>
  </tr>`).join("");
  $("#catalog-empty").hidden = items.length > 0;
}

function openCatalogForm(item = null) {
  markDirty("catalog", false);
  $("#catalog-price").setCustomValidity("");
  $("#catalog-price").removeAttribute("aria-invalid");
  $("#catalog-dialog-title").textContent = item ? "编辑收费项目" : "新建收费项目";
  $("#catalog-id").value = item?.id || "";
  $("#catalog-code").value = item?.code || "";
  $("#catalog-name").value = item?.name || "";
  $("#catalog-specification").value = item?.specification || "";
  $("#catalog-unit").value = item?.unit || "次";
  $("#catalog-price").value = item ? moneyInputText(item.unitPriceCents) : "";
  $("#catalog-category").value = item?.category || "";
  $("#catalog-summary-category").value = item?.summaryCategory || "";
  $("#catalog-enabled").checked = item?.enabled !== false;
  $("#catalog-dialog").showModal();
  setTimeout(() => $("#catalog-code").focus(), 0);
}

async function submitCatalog(event) {
  event?.preventDefault();
  if (!$("#catalog-form").reportValidity()) return false;
  const id = $("#catalog-id").value;
  const code = $("#catalog-code").value.trim();
  const name = $("#catalog-name").value.trim();
  const specification = $("#catalog-specification").value.trim();
  const unit = $("#catalog-unit").value.trim();
  const price = validateNumberControl($("#catalog-price"), parseCents);
  if (!price.valid) { setTimeout(() => $("#catalog-price").reportValidity(), 0); return false; }
  const unitPriceCents = price.value;
  if (!code || !name || !unit || unitPriceCents < 0) { showToast("请完整填写项目编码、名称、单位与价格", true); return; }
  const duplicate = store.catalogItems.find((item) => item.code.toLocaleLowerCase() === code.toLocaleLowerCase() && item.id !== id);
  if (duplicate) { showToast("项目编码已存在", true); $("#catalog-code").focus(); return; }
  const previous = store.catalogItems.find((item) => item.id === id);
  if (!previous && store.catalogItems.length >= MAX_CATALOG_ITEMS) throw new Error("项目目录已达到支持上限。");
  const previousCatalogItems = clone(store.catalogItems);
  const item = {
    id: id || createId("catalog"), code, name, specification, unit,
    unitPriceCents, category: $("#catalog-category").value.trim(),
    summaryCategory: $("#catalog-summary-category").value.trim(), enabled: $("#catalog-enabled").checked,
    createdAt: previous?.createdAt || nowIso(), updatedAt: nowIso(),
  };
  if (previous) store.catalogItems[store.catalogItems.findIndex((entry) => entry.id === id)] = item;
  else store.catalogItems.push(item);
  if (!(await persistStore(previous ? "项目已更新" : "项目已新增"))) {
    store.catalogItems = previousCatalogItems;
    return false;
  }
  markDirty("catalog", false);
  $("#catalog-dialog").close();
  renderCatalog(); renderPalette();
  return true;
}

async function catalogAction(action, id) {
  const item = store.catalogItems.find((entry) => entry.id === id);
  if (!item) return;
  if (action === "edit") return openCatalogForm(item);
  const previousCatalogItems = clone(store.catalogItems);
  if (action === "toggle") {
    item.enabled = item.enabled === false;
    item.updatedAt = nowIso();
    if (!(await persistStore(item.enabled ? "项目已启用" : "项目已停用"))) {
      store.catalogItems = previousCatalogItems;
      renderCatalog(); renderPalette();
      return;
    }
  }
  if (action === "delete") {
    const referenced = store.documents.some((doc) => doc.lines?.some((line) => line.catalogItemId === id));
    if (referenced) { showToast("该项目已被单据引用，请改为停用", true); return; }
    if (!window.confirm(`确定删除“${item.name}”？此操作无法撤销。`)) return;
    store.catalogItems = store.catalogItems.filter((entry) => entry.id !== id);
    if (!(await persistStore("项目已删除"))) {
      store.catalogItems = previousCatalogItems;
      renderCatalog(); renderPalette();
      return;
    }
  }
  renderCatalog(); renderPalette();
}

function profileContentSize(profile) {
  const margins = profile.marginsMm || {};
  return {
    width: Math.max(10, Number(profile.paperWidthMm) - (Number(margins.left) || 0) - (Number(margins.right) || 0)),
    height: Math.max(10, Number(profile.paperHeightMm) - (Number(margins.top) || 0) - (Number(margins.bottom) || 0)),
  };
}

function renderPrintProfiles() {
  $("#print-profiles").innerHTML = store.printProfiles.map((profile, index) => {
    const content = profileContentSize(profile);
    const isSquare = Math.abs(profile.paperWidthMm - profile.paperHeightMm) < 5;
    return `<article class="profile-card" data-profile-id="${escapeHtml(profile.id)}">
      <header class="profile-card-head"><div><span>PROFILE ${String(index + 1).padStart(2, "0")}</span><h3>${escapeHtml(profile.name)}</h3></div><span class="profile-tag">${profile.mode === "preprinted" ? "套打" : "完整打印"}</span></header>
      <div class="profile-body"><div class="paper-diagram"><div class="paper-mini ${isSquare ? "square" : "landscape"}">${escapeHtml(profile.paperWidthMm)} × ${escapeHtml(profile.paperHeightMm)} mm<span class="offset-dot"></span></div></div>
      <div class="profile-fields">
        <label><span>纸张宽度</span><div class="unit-field"><input data-profile-field="paperWidthMm" inputmode="decimal" value="${escapeHtml(profile.paperWidthMm)}"><i>mm</i></div></label>
        <label><span>纸张高度</span><div class="unit-field"><input data-profile-field="paperHeightMm" inputmode="decimal" value="${escapeHtml(profile.paperHeightMm)}"><i>mm</i></div></label>
        <label><span>内容宽度</span><div class="unit-field"><input data-profile-field="contentWidthMm" inputmode="decimal" value="${content.width}"><i>mm</i></div></label>
        <label><span>内容高度</span><div class="unit-field"><input data-profile-field="contentHeightMm" inputmode="decimal" value="${content.height}"><i>mm</i></div></label>
        <label><span>X 横向校准</span><div class="unit-field"><input data-profile-field="offsetX" inputmode="decimal" value="${escapeHtml(profile.offsetMm?.x || 0)}"><i>mm</i></div></label>
        <label><span>Y 纵向校准</span><div class="unit-field"><input data-profile-field="offsetY" inputmode="decimal" value="${escapeHtml(profile.offsetMm?.y || 0)}"><i>mm</i></div></label>
        <label class="span-2"><span>打印机名称（选填）</span><input data-profile-field="printerName" list="printer-options" value="${escapeHtml(profile.printerName || "")}" placeholder="留空使用系统默认打印机"></label>
        <label class="toggle-field span-2"><span>默认打印档案</span><input type="radio" name="default-profile" data-profile-field="isDefault" ${profile.id === defaultProfileId() ? "checked" : ""}><i aria-hidden="true"></i><strong>设为默认</strong></label>
      </div></div></article>`;
  }).join("");
  $$(".profile-card", $("#print-profiles")).forEach((card) => {
    const profile = store.printProfiles.find((item) => item.id === card.dataset.profileId);
    const dot = $(".offset-dot", card);
    if (!profile || !dot) return;
    dot.style.setProperty("--offset-x", `${Math.max(-20, Math.min(20, Number(profile.offsetMm?.x) || 0)) * 2}px`);
    dot.style.setProperty("--offset-y", `${Math.max(-20, Math.min(20, Number(profile.offsetMm?.y) || 0)) * 2}px`);
  });
}

async function savePrintSettings() {
  const previousSettings = clone(store.settings);
  const previousProfiles = clone(store.printProfiles);
  const profiles = clone(store.printProfiles);
  const settings = { ...store.settings, organizationName: $("#settings-organization").value.trim(), defaultOperator: $("#settings-operator").value.trim() || "收费员" };
  const readNumber = (card, field, min, max) => {
    const control = $("[data-profile-field='" + field + "']", card);
    const result = validateNumberControl(control, (raw) => {
      const number = Number(raw);
      if (!String(raw).trim() || !Number.isFinite(number) || number < min || number > max) throw new Error("请输入 " + min + " 至 " + max + " 之间的数值");
      return number;
    });
    if (!result.valid) { setTimeout(() => { control.focus(); control.reportValidity(); }, 0); throw new Error("打印尺寸或偏移量有误，请检查标红字段"); }
    return result.value;
  };
  for (const card of $$(".profile-card", $("#print-profiles"))) {
    const profile = profiles.find((item) => item.id === card.dataset.profileId);
    if (!profile) continue;
    const width = readNumber(card, "paperWidthMm", 25, 500);
    const height = readNumber(card, "paperHeightMm", 25, 500);
    const contentWidth = readNumber(card, "contentWidthMm", 10, width);
    const contentHeight = readNumber(card, "contentHeightMm", 10, height);
    const left = (width - contentWidth) / 2, top = (height - contentHeight) / 2;
    profile.paperWidthMm = width; profile.paperHeightMm = height;
    profile.marginsMm = { top, right: left, bottom: top, left };
    profile.offsetMm = { x: readNumber(card, "offsetX", -100, 100), y: readNumber(card, "offsetY", -100, 100) };
    profile.printerName = $("[data-profile-field='printerName']", card).value.trim();
    profile.isDefault = $("[data-profile-field='isDefault']", card).checked;
    if (profile.isDefault) settings.defaultPrintProfileId = profile.id;
  }
  store.settings = settings; store.printProfiles = profiles;
  if (!(await persistStore("打印设置已保存"))) {
    store.settings = previousSettings; store.printProfiles = previousProfiles;
    return false;
  }
  markDirty("settings", false);
  renderPrintProfiles(); renderProfileSelect();
  return true;
}

async function loadPrinterOptions() {
  if (!window.clinicDesktop?.getPrinters) return;
  try {
    const printers = await window.clinicDesktop.getPrinters();
    $("#printer-options").innerHTML = (Array.isArray(printers) ? printers : [])
      .map((printer) => `<option value="${escapeHtml(printer.name || printer.displayName || "")}">${escapeHtml(printer.displayName || printer.name || "")}${printer.isDefault ? "（系统默认）" : ""}</option>`)
      .join("");
  } catch {
    $("#printer-options").innerHTML = "";
  }
}

async function exportBackup() {
  if (!window.clinicDesktop?.exportBackup) {
    showToast("备份导出仅在桌面版可用", true);
    return;
  }
  if (!window.confirm("导出的备份是明文文件，可能包含姓名和收费记录。确认继续吗？")) return;
  try {
    const result = await window.clinicDesktop.exportBackup(store);
    if (result?.canceled) return;
    showToast("备份已导出");
  } catch (error) {
    showToast(error?.message || "备份导出失败", true);
  }
}

async function importBackup() {
  if (!window.clinicDesktop?.importBackup) { showToast("备份导入仅在桌面版可用", true); return false; }
  if (!(await resolveUnsaved())) return false;
  const result = await window.clinicDesktop.importBackup();
  if (result?.canceled) return false;
  const restored = validateStoredStore(result.data);
  const date = result.exportedAt ? new Date(result.exportedAt).toLocaleString("zh-CN") : "旧版备份（无导出日期）";
  if (!window.confirm("将恢复 " + restored.documents.length + " 张单据、" + restored.catalogItems.length + " 个项目。\n备份时间：" + date + "\n现有数据会先留存副本，然后被此备份替换。确定恢复吗？")) return false;
  await window.clinicDesktop.restoreBackup(restored);
  await initialize();
  showToast("备份已恢复，原数据已留存");
  return true;
}

function printMarkup(doc, profile) {
  const org = doc.organizationName || store.settings?.organizationName || "门诊部";
  const title = store.settings?.documentTitle || "门诊项目明细清单";
  return `<div class="print-content ${profile.mode === "preprinted" ? "is-preprinted" : ""}">
    ${doc.status !== "confirmed" ? `<div class="print-status">${doc.status === "voided" ? "已作废 · 仅供核对" : "草稿 · 尚未确认"}</div>` : ""}
    <h2>${escapeHtml(title)}</h2>
    <div class="print-meta"><span>医疗机构：${escapeHtml(org)}</span><span>内部流水号：${escapeHtml(doc.serial || "")}</span><span>姓名：${escapeHtml(doc.patientName || "")}</span><span>收费日期：${escapeHtml(doc.businessDate || "")}</span><span>统计时间：${escapeHtml(doc.statisticsStartDate || "—")} 至 ${escapeHtml(doc.statisticsEndDate || "—")}</span><span>开具医生：${escapeHtml(doc.doctorName || "—")} / 录入：${escapeHtml(doc.operatorName || "收费员")}</span></div>
    <table><thead><tr><th>项目名称及规格 / 类别</th><th>单价</th><th>数量</th><th>单位</th><th>金额</th></tr></thead><tbody>${(doc.lines || []).map((line) => `<tr><td>${escapeHtml(displayItemName(line.itemSnapshot))}<small class="print-category">${escapeHtml(line.itemSnapshot?.category || "未分类")} / ${escapeHtml(line.itemSnapshot?.summaryCategory || "未分类")}</small></td><td class="print-money">${moneyInputText(line.unitPriceCents)}</td><td class="print-money">${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.itemSnapshot?.unit || "次")}</td><td class="print-money">${moneyInputText(lineAmount(line))}</td></tr>`).join("")}</tbody></table>
    <div class="print-total"><span>大写：${escapeHtml(uppercaseText(doc.totalCents))}</span><span>合计：${moneyText(doc.totalCents)}</span></div>
    <div class="print-note-line">${escapeHtml(org)} 内部使用，不作报销凭证${doc.note ? ` 备注：${escapeHtml(doc.note)}` : ""}</div>
  </div>`;
}

function showPrintPreview(doc = currentDocument) {
  if (doc.id === currentDocument.id && currentDocument.status === "draft") {
    if (!validateBillingInputs()) return false;
    updateCurrentFromInputs();
    doc = currentDocument;
  } else {
    doc = store.documents.find((item) => item.id === doc.id) || doc;
  }
  if (!doc.lines?.length) { showToast("请先添加至少一个收费项目", true); return false; }
  previewDocument = clone(doc);
  const selectedProfileId = doc.id === currentDocument.id ? $("#billing-profile").value : doc.printProfileId;
  const profile = store.printProfiles.find((item) => item.id === selectedProfileId) || store.printProfiles[0];
  if (!profile) { showToast("请先配置打印档案", true); return false; }
  previewProfile = clone(profile);
  const content = profileContentSize(profile), sheet = $("#print-sheet");
  sheet.style.width = profile.paperWidthMm + "mm";
  sheet.style.height = profile.paperHeightMm + "mm";
  sheet.innerHTML = printMarkup(doc, profile);
  const printContent = $(".print-content", sheet);
  printContent.style.width = content.width + "mm";
  printContent.style.height = content.height + "mm";
  printContent.style.left = ((profile.marginsMm?.left || 0) + (profile.offsetMm?.x || 0)) + "mm";
  printContent.style.top = ((profile.marginsMm?.top || 0) + (profile.offsetMm?.y || 0)) + "mm";
  printContent.style.padding = profile.mode === "blank" ? "3mm" : "1mm";
  $("#preview-profile-name").textContent = profile.name + " · " + profile.paperWidthMm + "×" + profile.paperHeightMm + " mm";
  if (!$("#print-dialog").open) $("#print-dialog").showModal();
  requestAnimationFrame(checkPrintBounds);
  return true;
}

function checkPrintBounds() {
  const content = $("#print-sheet .print-content");
  if (!content || !previewProfile) return false;
  const sheet = $("#print-sheet").getBoundingClientRect();
  const box = content.getBoundingClientRect();
  const overflow = content.scrollHeight > content.clientHeight + 1 || content.scrollWidth > content.clientWidth + 1 || box.left < sheet.left - 1 || box.top < sheet.top - 1 || box.right > sheet.right + 1 || box.bottom > sheet.bottom + 1;
  const uncalibrated = previewProfile.mode === "preprinted";
  const warning = $("#print-warning");
  warning.hidden = !overflow && !uncalibrated;
  warning.textContent = uncalibrated ? "套打模板待提供空白票据后定稿，暂不能套打。请先选择空白纸完整打印。" : overflow ? "清单超出单张纸范围，请调整纸型或内容区域；本次打印已暂停，避免漏打金额。" : "";
  $("#print-now").disabled = overflow || uncalibrated;
  return !overflow && !uncalibrated;
}

async function printNow() {
  if (!previewDocument || !previewProfile) return false;
  const latest = store.documents.find((doc) => doc.id === previewDocument.id);
  if (latest && latest.status !== previewDocument.status) {
    showPrintPreview(latest);
    showToast("单据状态已更新，请重新核对预览", true);
    return false;
  }
  await document.fonts.ready;
  if (!checkPrintBounds()) return false;
  try {
    if (window.clinicDesktop?.print) {
      const result = await window.clinicDesktop.print({ profile: previewProfile, deviceName: previewProfile.printerName || "" });
      if (result?.success === false && !result?.canceled) throw new Error(result.error || "系统打印失败");
      if (!result?.canceled) showToast("打印任务已发送");
    } else window.print();
    return true;
  } catch (error) { showToast(error?.message || "打印失败，请检查打印机", true); return false; }
}

async function navigateView(name) {
  if (currentView === "printing" && name !== "printing" && !(await resolveUnsaved(["settings"]))) return false;
  if (name === currentView) return true;
  switchView(name);
  return true;
}

async function editHistoryDocument(doc) {
  if (doc.id !== currentDocument.id && !(await resolveUnsaved(["billing"]))) return false;
  if (doc.id === currentDocument.id && dirtyAreas.has("billing")) {
    $("#history-dialog").close(); switchView("billing"); return true;
  }
  selectDocument(clone(store.documents.find((item) => item.id === doc.id) || doc));
  $("#history-dialog").close();
  switchView("billing");
  return true;
}

function bindEvents() {
  if (eventsBound) return;
  eventsBound = true;
  const on = (selector, event, action) => $(selector).addEventListener(event, (evt) => {
    if (event === "submit") evt.preventDefault();
    void runExclusive(() => action(evt));
  });
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => void runExclusive(() => navigateView(button.dataset.view))));
  $$("[data-go-view]").forEach((button) => button.addEventListener("click", () => void runExclusive(() => navigateView(button.dataset.goView))));
  on("#new-document", "click", async () => {
    if (!(await resolveUnsaved(["billing"]))) return false;
    selectDocument(createFreshDocument());
    setTimeout(() => $("#patient-name").focus(), 0);
  });
  on("#save-draft", "click", saveDraft);
  on("#confirm-document", "click", confirmCurrent);
  on("#preview-document", "click", () => showPrintPreview());
  $("#billing-profile").addEventListener("change", () => {
    if (!currentDocument.locked) { updateCurrentFromInputs(); markDirty("billing"); }
  });
  $("#heading-fields").addEventListener("input", () => { updateCurrentFromInputs(); markDirty("billing"); });
  $("#document-note").addEventListener("input", () => { updateCurrentFromInputs(); markDirty("billing"); });
  on("#add-temp-line", "click", addTemporaryItem);
  on("#add-catalog-line", "click", () => { $("#picker-search").value = ""; renderPicker(); $("#picker-dialog").showModal(); });
  on("#close-picker", "click", () => $("#picker-dialog").close());
  $("#picker-search").addEventListener("input", renderPicker);
  on("#picker-list", "click", (event) => {
    const button = event.target.closest("[data-item-id]"); if (!button) return;
    const item = store.catalogItems.find((entry) => entry.id === button.dataset.itemId); if (!item) return;
    addCatalogItem(item); $("#picker-dialog").close();
  });
  $("#palette-search").addEventListener("input", renderPalette);
  on("#palette-list", "click", (event) => {
    const button = event.target.closest("[data-item-id]"); if (!button) return;
    const item = store.catalogItems.find((entry) => entry.id === button.dataset.itemId); if (item) addCatalogItem(item);
  });
  $("#line-items").addEventListener("input", (event) => { const row = event.target.closest("tr"); if (row) mutateLineFromRow(row); });
  $("#line-items").addEventListener("focusout", (event) => {
    if (event.target.dataset.field === "unitPrice" && event.target.getAttribute("aria-invalid") !== "true") {
      event.target.value = moneyInputText(parseCents(event.target.value));
      const edits = lineEdits.get(event.target.closest("tr").dataset.lineId);
      if (edits) edits.price = event.target.value;
    }
  });
  $("#line-items").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-line"); if (!button || currentDocument.locked) return;
    void runExclusive(() => {
      const id = button.closest("tr").dataset.lineId;
      currentDocument.lines = currentDocument.lines.filter((line) => line.id !== id);
      lineEdits.delete(id); markDirty("billing"); renderLines();
    });
  });
  on("#history-filter", "submit", () => { historyPage = 1; renderHistory(); });
  on("#reset-filter", "click", () => { $("#history-filter").reset(); historyPage = 1; renderHistory(); });
  on("#history-prev", "click", () => { historyPage -= 1; renderHistory(); });
  on("#history-next", "click", () => { historyPage += 1; renderHistory(); });
  on("#history-rows", "click", async (event) => {
    const button = event.target.closest("[data-history-action]"); if (!button) return;
    const doc = store.documents.find((item) => item.id === button.dataset.id); if (!doc) return;
    if (button.dataset.historyAction === "edit") return editHistoryDocument(doc);
    if (button.dataset.historyAction === "print") return showPrintPreview(doc);
    renderHistoryDetail(doc); $("#history-dialog").showModal();
  });
  on("#close-history-dialog", "click", () => $("#history-dialog").close());
  on("#history-actions", "click", async (event) => {
    const button = event.target.closest("[data-modal-action]"); if (!button) return;
    const doc = store.documents.find((item) => item.id === activeHistoryId); if (!doc) return;
    const action = button.dataset.modalAction;
    if (action === "print") { $("#history-dialog").close(); return showPrintPreview(doc); }
    if (action === "void") return voidRecord(doc, false);
    if (action === "void-reopen") return voidRecord(doc, true);
    if (action === "reopen") return reopenVoided(doc);
    if (action === "edit") return editHistoryDocument(doc);
  });
  on("#create-catalog-item", "click", () => openCatalogForm());
  const closeCatalog = async () => { if (await resolveUnsaved(["catalog"])) $("#catalog-dialog").close(); };
  on("#close-catalog-dialog", "click", closeCatalog);
  on("#cancel-catalog", "click", closeCatalog);
  $("#catalog-dialog").addEventListener("cancel", (event) => { event.preventDefault(); void runExclusive(closeCatalog); });
  on("#catalog-form", "submit", submitCatalog);
  $("#catalog-form").addEventListener("input", (event) => {
    markDirty("catalog");
    if (event.target.id === "catalog-price") validateNumberControl(event.target, parseCents);
  });
  $("#catalog-search").addEventListener("input", renderCatalog);
  on("#catalog-rows", "click", (event) => {
    const button = event.target.closest("[data-catalog-action]");
    if (button) return catalogAction(button.dataset.catalogAction, button.dataset.id);
  });
  on("#save-print-settings", "click", savePrintSettings);
  on("#export-backup", "click", async () => {
    if (await resolveUnsaved()) return exportBackup();
  });
  on("#import-backup", "click", importBackup);
  on("#open-data-folder", "click", () => window.clinicDesktop?.openDataFolder?.());
  $("#view-printing").addEventListener("input", (event) => {
    if (event.target.matches("input")) markDirty("settings");
  });
  $("#print-profiles").addEventListener("input", (event) => {
    const card = event.target.closest(".profile-card"); if (!card) return;
    const x = Number($("[data-profile-field='offsetX']", card)?.value) || 0;
    const y = Number($("[data-profile-field='offsetY']", card)?.value) || 0;
    const dot = $(".offset-dot", card);
    if (dot) { dot.style.setProperty("--offset-x", Math.max(-20, Math.min(20, x)) * 2 + "px"); dot.style.setProperty("--offset-y", Math.max(-20, Math.min(20, y)) * 2 + "px"); }
  });
  on("#close-print-preview", "click", () => $("#print-dialog").close());
  on("#print-now", "click", printNow);
  document.addEventListener("keydown", (event) => {
    if (operationPromise) { if (["F2","F3","F4","F5","s","S"].includes(event.key)) event.preventDefault(); return; }
    if ($("dialog[open]")) return;
    const view = { F2: "billing", F3: "history", F4: "catalog", F5: "printing" }[event.key];
    if (view) { event.preventDefault(); void runExclusive(() => navigateView(view)); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (currentView === "billing") void runExclusive(saveDraft);
      else if (currentView === "printing") void runExclusive(savePrintSettings);
    }
  });
}

function updateClock() {
  const date = new Date();
  $("#sidebar-clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(date);
}

async function initialize() {
  await loadStore();
  const blankProfile = store.printProfiles.find((profile) => profile.id === "blank-241x140");
  if (blankProfile && blankProfile.paperWidthMm === 241 && blankProfile.paperHeightMm === 140
    && blankProfile.marginsMm?.left === 8 && blankProfile.marginsMm?.right === 8
    && blankProfile.marginsMm?.top === 6 && blankProfile.marginsMm?.bottom === 6) {
    blankProfile.marginsMm = { top: 0, right: 15.5, bottom: 0, left: 15.5 };
  }
  dirtyAreas.clear(); lineEdits.clear(); historyPage = 1;
  window.clinicDesktop?.setDirty?.(false).catch(() => {});
  bindEvents();
  updateClock();
  if (!clockTimer) clockTimer = setInterval(updateClock, 30_000);
  $("#recovery-screen").hidden = true;
  $(".app-shell").hidden = false;
  $$("dialog[open]").forEach((dialog) => dialog.close());
  selectDocument(createFreshDocument());
  renderCatalog(); renderHistory(); renderLocalSettings(); renderPrintProfiles();
  switchView("billing"); updateCapacity();
  document.body.dataset.appReady = "true";
  void loadPrinterOptions();
}

function showRecovery(error) {
  console.error(error);
  document.body.dataset.appReady = "false";
  $(".app-shell").hidden = true;
  $("#recovery-screen").hidden = false;
  $("#recovery-error").textContent = error?.message || "无法读取本机数据，原文件已保留。";
  if (window.clinicDesktop?.getStorageInfo) {
    window.clinicDesktop.getStorageInfo().then((info) => {
      $("#restore-previous").disabled = !info.previousBackupAvailable;
      $("#recovery-data-path").textContent = info.dataPath;
    }).catch(() => {});
  }
}

async function recoverFromFile() {
  try {
    if (await importBackup()) return;
  } catch (error) { $("#recovery-error").textContent = error.message; }
}

$("#recovery-import").addEventListener("click", () => void runExclusive(recoverFromFile));
$("#recovery-folder").addEventListener("click", () => void runExclusive(() => window.clinicDesktop?.openDataFolder?.()));
$("#recovery-retry").addEventListener("click", () => void runExclusive(() => initialize().catch(showRecovery)));
$("#restore-previous").addEventListener("click", () => void runExclusive(async () => {
  if (!window.confirm("恢复本机上一份自动副本？故障文件会另行保留。")) return false;
  try { await window.clinicDesktop.restorePreviousBackup(); await initialize(); showToast("已恢复上一份自动副本"); }
  catch (error) { $("#recovery-error").textContent = error.message; }
}));

window.clinicDesktop?.onCloseRequest?.(async () => {
  if (operationPromise) await operationPromise;
  const close = await runExclusive(() => resolveUnsaved());
  await window.clinicDesktop.respondClose({ action: close ? "close" : "cancel" });
});
window.addEventListener("beforeunload", (event) => {
  if (!window.clinicDesktop && dirtyAreas.size) { event.preventDefault(); event.returnValue = ""; }
});

initialize().catch(showRecovery);
