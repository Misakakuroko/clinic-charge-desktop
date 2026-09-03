import {
  DEFAULT_PRINT_PROFILES,
  createEmptyStore,
  normalizeStore,
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

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
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
  try {
    const cents = parseMoneyToCents(String(value ?? ""));
    return isFiniteNumber(cents) ? cents : 0;
  } catch {
    const number = Number(String(value ?? "").replaceAll(",", ""));
    return Number.isFinite(number) ? Math.round(number * 100) : 0;
  }
}

function lineAmount(line) {
  try {
    return calculateLineAmount(line.unitPriceCents, line.quantity);
  } catch {
    return Math.round((Number(line.unitPriceCents) || 0) * (Number(line.quantity) || 0));
  }
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
  try { return nextSerial(store.documents, date); }
  catch {
    const day = date.replaceAll("-", "");
    const count = store.documents.filter((item) => String(item.serial || "").startsWith(day)).length + 1;
    return `${day}${String(count).padStart(4, "0")}`;
  }
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
  const normalized = normalizeStore(value || createEmptyStore());
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
    store = normalizeLoaded(null);
  }
  storageProtection = "browser";
  setStorageLabel("browser");
}

async function persistStore(message = "已保存到本机") {
  $("#save-state").textContent = "保存中…";
  try {
    if (window.clinicDesktop?.saveData) {
      await window.clinicDesktop.saveData(store);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    }
    $("#save-state").textContent = "已同步";
    if (message) showToast(message);
    return true;
  } catch (error) {
    console.error(error);
    $("#save-state").textContent = "保存失败";
    showToast("保存失败，请稍后重试", true);
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
    return `<tr data-line-id="${escapeHtml(line.id)}">
      <td class="row-num">${String(index + 1).padStart(2, "0")}</td>
      <td><input class="name-input" data-field="name" value="${escapeHtml(displayItemName(item))}" aria-label="第${index + 1}项名称及规格" ${locked ? "disabled" : ""}></td>
      <td><input class="money-input" data-field="unitPrice" inputmode="decimal" value="${moneyInputText(line.unitPriceCents)}" aria-label="第${index + 1}项单价" ${locked ? "disabled" : ""}></td>
      <td><input class="qty-input" data-field="quantity" inputmode="decimal" value="${escapeHtml(line.quantity ?? 1)}" aria-label="第${index + 1}项数量" ${locked ? "disabled" : ""}></td>
      <td><input class="unit-input" data-field="unit" value="${escapeHtml(item.unit || "次")}" maxlength="8" aria-label="第${index + 1}项单位" ${locked ? "disabled" : ""}></td>
      <td class="line-amount">${moneyText(line.amountCents)}</td>
      <td><button class="remove-line" type="button" title="删除此项" aria-label="删除第${index + 1}项" ${locked ? "disabled" : ""}>×</button></td>
    </tr>`;
  }).join("");
  $("#lines-empty").hidden = currentDocument.lines.length > 0;
  $("#line-count").textContent = `${currentDocument.lines.length} 项`;
  $("#total-amount").textContent = moneyText(currentDocument.totalCents);
  $("#total-uppercase").textContent = uppercaseText(currentDocument.totalCents);
}

function mutateLineFromRow(row) {
  const line = currentDocument.lines.find((item) => item.id === row.dataset.lineId);
  if (!line) return;
  const nameAndSpec = $("[data-field='name']", row).value.trim();
  const price = parseCents($("[data-field='unitPrice']", row).value);
  const rawQuantity = Number($("[data-field='quantity']", row).value);
  const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? rawQuantity : 1;
  const unit = $("[data-field='unit']", row).value.trim() || "次";
  line.itemSnapshot = { ...(line.itemSnapshot || {}), name: nameAndSpec, specification: "", unit, unitPriceCents: price };
  line.unitPriceCents = price;
  line.quantity = quantity;
  line.amountCents = lineAmount(line);
  currentDocument.totalCents = currentDocument.lines.reduce((sum, item) => sum + lineAmount(item), 0);
  $(".line-amount", row).textContent = moneyText(line.amountCents);
  $("#total-amount").textContent = moneyText(currentDocument.totalCents);
  $("#total-uppercase").textContent = uppercaseText(currentDocument.totalCents);
  currentDocument.updatedAt = nowIso();
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
  renderLines();
  showToast(`已添加：${item.name}`);
}

function addTemporaryItem() {
  const item = { id: createId("temp-item"), code: "TEMP", name: "临时项目", specification: "", unit: "次", unitPriceCents: 0, enabled: true };
  currentDocument.lines.push(itemToLine(item));
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
  updateCurrentFromInputs();
  if (currentDocument.locked) return;
  const previousDocuments = clone(store.documents);
  upsertDocument(currentDocument);
  if (!(await persistStore("草稿已保存到本机"))) {
    store.documents = previousDocuments;
  }
}

async function confirmCurrent() {
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
    renderBilling();
  } catch (error) {
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
  $("#history-rows").innerHTML = documents.map((doc) => `<tr>
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

async function voidRecord(doc, reopenAfter = false) {
  const reason = window.prompt("请输入作废原因（会保留在历史记录中）：", "录入有误");
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
    $("#history-dialog").close();
    if (reopenAfter) { renderBilling(); switchView("billing"); }
    else renderHistory();
  } catch (error) { showToast(error?.message || "作废失败", true); }
}

async function reopenVoided(doc) {
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
    renderBilling();
    switchView("billing");
  } catch (error) { showToast(error?.message || "重开失败", true); }
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
  event.preventDefault();
  const id = $("#catalog-id").value;
  const code = $("#catalog-code").value.trim();
  const name = $("#catalog-name").value.trim();
  const specification = $("#catalog-specification").value.trim();
  const unit = $("#catalog-unit").value.trim();
  const unitPriceCents = parseCents($("#catalog-price").value);
  if (!code || !name || !unit || unitPriceCents < 0) { showToast("请完整填写项目编码、名称、单位与价格", true); return; }
  const duplicate = store.catalogItems.find((item) => item.code.toLocaleLowerCase() === code.toLocaleLowerCase() && item.id !== id);
  if (duplicate) { showToast("项目编码已存在", true); $("#catalog-code").focus(); return; }
  const previous = store.catalogItems.find((item) => item.id === id);
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
    return;
  }
  $("#catalog-dialog").close();
  renderCatalog(); renderPalette();
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
  store.settings.organizationName = $("#settings-organization").value.trim();
  store.settings.defaultOperator = $("#settings-operator").value.trim() || "收费员";
  const cards = $$(".profile-card", $("#print-profiles"));
  for (const card of cards) {
    const profile = store.printProfiles.find((item) => item.id === card.dataset.profileId);
    if (!profile) continue;
    const width = Math.max(20, Number($("[data-profile-field='paperWidthMm']", card).value) || profile.paperWidthMm);
    const height = Math.max(20, Number($("[data-profile-field='paperHeightMm']", card).value) || profile.paperHeightMm);
    const contentWidth = Math.min(width, Math.max(10, Number($("[data-profile-field='contentWidthMm']", card).value) || width));
    const contentHeight = Math.min(height, Math.max(10, Number($("[data-profile-field='contentHeightMm']", card).value) || height));
    const left = Math.max(0, (width - contentWidth) / 2);
    const top = Math.max(0, (height - contentHeight) / 2);
    profile.paperWidthMm = width; profile.paperHeightMm = height;
    profile.marginsMm = { top, right: Math.max(0, width - contentWidth - left), bottom: Math.max(0, height - contentHeight - top), left };
    profile.offsetMm = { x: Number($("[data-profile-field='offsetX']", card).value) || 0, y: Number($("[data-profile-field='offsetY']", card).value) || 0 };
    profile.printerName = $("[data-profile-field='printerName']", card).value.trim();
    profile.isDefault = $("[data-profile-field='isDefault']", card).checked;
    if (profile.isDefault) store.settings.defaultPrintProfileId = profile.id;
  }
  if (!store.printProfiles.some((profile) => profile.isDefault)) store.printProfiles[0].isDefault = true;
  if (!(await persistStore("打印设置已保存"))) {
    store.settings = previousSettings;
    store.printProfiles = previousProfiles;
    renderLocalSettings();
    renderPrintProfiles();
    renderProfileSelect();
    return;
  }
  renderPrintProfiles(); renderProfileSelect();
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
  if (!window.clinicDesktop?.importBackup) {
    showToast("备份导入仅在桌面版可用", true);
    return;
  }
  if (!window.confirm("导入会用备份内容替换当前本机数据，确认继续吗？")) return;
  const previousStore = clone(store);
  const previousCurrentDocument = clone(currentDocument);
  try {
    const result = await window.clinicDesktop.importBackup();
    if (result?.canceled) return;
    store = normalizeLoaded(result?.data);
    currentDocument = createFreshDocument();
    if (!(await persistStore("备份已导入并保存"))) {
      store = previousStore;
      currentDocument = previousCurrentDocument;
      return;
    }
    renderBilling();
    renderCatalog();
    renderHistory();
    renderLocalSettings();
    renderPrintProfiles();
  } catch (error) {
    showToast(error?.message || "备份导入失败", true);
  }
}

function printMarkup(doc, profile) {
  const org = doc.organizationName || store.settings?.organizationName || "门诊部";
  const title = store.settings?.documentTitle || "门诊项目明细清单";
  return `<div class="print-content ${profile.mode === "preprinted" ? "is-preprinted" : ""}">
    <h2>${escapeHtml(title)}</h2>
    <div class="print-meta"><span>医疗机构：${escapeHtml(org)}</span><span>内部流水号：${escapeHtml(doc.serial || "")}</span><span>姓名：${escapeHtml(doc.patientName || "")}</span><span>收费日期：${escapeHtml(doc.businessDate || "")}</span><span>统计时间：${escapeHtml(doc.statisticsStartDate || "—")} 至 ${escapeHtml(doc.statisticsEndDate || "—")}</span><span>开具医生：${escapeHtml(doc.doctorName || "—")} / 录入：${escapeHtml(doc.operatorName || "收费员")}</span></div>
    <table><thead><tr><th>项目名称及规格 / 类别</th><th>单价</th><th>数量</th><th>单位</th><th>金额</th></tr></thead><tbody>${(doc.lines || []).map((line) => `<tr><td>${escapeHtml(displayItemName(line.itemSnapshot))}<small class="print-category">${escapeHtml(line.itemSnapshot?.category || "未分类")} / ${escapeHtml(line.itemSnapshot?.summaryCategory || "未分类")}</small></td><td class="print-money">${moneyInputText(line.unitPriceCents)}</td><td class="print-money">${escapeHtml(line.quantity)}</td><td>${escapeHtml(line.itemSnapshot?.unit || "次")}</td><td class="print-money">${moneyInputText(lineAmount(line))}</td></tr>`).join("")}</tbody></table>
    <div class="print-total"><span>大写：${escapeHtml(uppercaseText(doc.totalCents))}</span><span>合计：${moneyText(doc.totalCents)}</span></div>
    <div class="print-note-line">${escapeHtml(org)} 内部使用，不作报销凭证${doc.note ? ` 备注：${escapeHtml(doc.note)}` : ""}</div>
  </div>`;
}

function showPrintPreview(doc = currentDocument) {
  updateCurrentFromInputs();
  if (!doc.lines?.length) { showToast("请先添加至少一个收费项目", true); return; }
  previewDocument = clone(doc);
  const profile = store.printProfiles.find((item) => item.id === (doc.printProfileId || $("#billing-profile").value)) || store.printProfiles[0];
  if (!profile) { showToast("请先配置打印档案", true); return; }
  const content = profileContentSize(profile);
  const sheet = $("#print-sheet");
  sheet.style.width = `${profile.paperWidthMm}mm`;
  sheet.style.height = `${profile.paperHeightMm}mm`;
  sheet.innerHTML = printMarkup(doc, profile);
  const printContent = $(".print-content", sheet);
  printContent.style.width = `${content.width}mm`;
  printContent.style.height = `${content.height}mm`;
  printContent.style.left = `${(profile.marginsMm?.left || 0) + (profile.offsetMm?.x || 0)}mm`;
  printContent.style.top = `${(profile.marginsMm?.top || 0) + (profile.offsetMm?.y || 0)}mm`;
  printContent.style.padding = profile.mode === "blank" ? "3mm" : "1mm";
  $("#preview-profile-name").textContent = `${profile.name} · ${profile.paperWidthMm}×${profile.paperHeightMm} mm`;
  $("#print-dialog").showModal();
}

async function printNow() {
  if (!previewDocument) return;
  const profile = store.printProfiles.find((item) => item.id === (previewDocument.printProfileId || defaultProfileId())) || store.printProfiles[0];
  try {
    if (window.clinicDesktop?.print) {
      const result = await window.clinicDesktop.print({ profile, deviceName: profile.printerName || "" });
      if (result?.success === false && !result?.canceled) throw new Error(result.error || "系统打印失败");
      if (!result?.canceled) showToast("打印任务已发送");
    } else {
      window.print();
    }
  } catch (error) { showToast(error?.message || "打印失败，请检查打印机", true); }
}

function bindEvents() {
  $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$('[data-go-view]').forEach((button) => button.addEventListener("click", () => switchView(button.dataset.goView)));
  $("#new-document").addEventListener("click", () => {
    if (currentDocument.status === "draft" && (currentDocument.patientName || currentDocument.lines.length) && !window.confirm("当前草稿尚未保存，确定新建吗？")) return;
    currentDocument = createFreshDocument(); renderBilling(); $("#patient-name").focus();
  });
  $("#save-draft").addEventListener("click", saveDraft);
  $("#confirm-document").addEventListener("click", confirmCurrent);
  $("#preview-document").addEventListener("click", () => showPrintPreview());
  $("#billing-profile").addEventListener("change", updateCurrentFromInputs);
  $("#heading-fields").addEventListener("input", updateCurrentFromInputs);
  $("#document-note").addEventListener("input", updateCurrentFromInputs);
  $("#add-temp-line").addEventListener("click", addTemporaryItem);
  $("#add-catalog-line").addEventListener("click", () => { $("#picker-search").value = ""; renderPicker(); $("#picker-dialog").showModal(); });
  $("#close-picker").addEventListener("click", () => $("#picker-dialog").close());
  $("#picker-search").addEventListener("input", renderPicker);
  $("#picker-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-item-id]"); if (!button) return;
    const item = store.catalogItems.find((entry) => entry.id === button.dataset.itemId); if (!item) return;
    addCatalogItem(item); $("#picker-dialog").close();
  });
  $("#palette-search").addEventListener("input", renderPalette);
  $("#palette-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-item-id]"); if (!button) return;
    const item = store.catalogItems.find((entry) => entry.id === button.dataset.itemId); if (item) addCatalogItem(item);
  });
  $("#line-items").addEventListener("input", (event) => { const row = event.target.closest("tr"); if (row) mutateLineFromRow(row); });
  $("#line-items").addEventListener("focusout", (event) => {
    if (event.target.dataset.field === "unitPrice") event.target.value = moneyInputText(parseCents(event.target.value));
  });
  $("#line-items").addEventListener("click", (event) => {
    const button = event.target.closest(".remove-line"); if (!button) return;
    const row = button.closest("tr"); currentDocument.lines = currentDocument.lines.filter((line) => line.id !== row.dataset.lineId); renderLines();
  });
  $("#history-filter").addEventListener("submit", (event) => { event.preventDefault(); renderHistory(); });
  $("#reset-filter").addEventListener("click", () => { $("#history-filter").reset(); renderHistory(); });
  $("#history-rows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-history-action]"); if (!button) return;
    const doc = store.documents.find((item) => item.id === button.dataset.id); if (!doc) return;
    if (button.dataset.historyAction === "edit") { currentDocument = clone(doc); renderBilling(); switchView("billing"); return; }
    if (button.dataset.historyAction === "print") { showPrintPreview(doc); return; }
    renderHistoryDetail(doc); $("#history-dialog").showModal();
  });
  $("#close-history-dialog").addEventListener("click", () => $("#history-dialog").close());
  $("#history-actions").addEventListener("click", (event) => {
    const button = event.target.closest("[data-modal-action]"); if (!button) return;
    const doc = store.documents.find((item) => item.id === activeHistoryId); if (!doc) return;
    const action = button.dataset.modalAction;
    if (action === "print") { $("#history-dialog").close(); showPrintPreview(doc); }
    if (action === "void") voidRecord(doc, false);
    if (action === "void-reopen") voidRecord(doc, true);
    if (action === "reopen") reopenVoided(doc);
    if (action === "edit") { currentDocument = clone(doc); $("#history-dialog").close(); renderBilling(); switchView("billing"); }
  });
  $("#create-catalog-item").addEventListener("click", () => openCatalogForm());
  $("#close-catalog-dialog").addEventListener("click", () => $("#catalog-dialog").close());
  $("#cancel-catalog").addEventListener("click", () => $("#catalog-dialog").close());
  $("#catalog-form").addEventListener("submit", submitCatalog);
  $("#catalog-search").addEventListener("input", renderCatalog);
  $("#catalog-rows").addEventListener("click", (event) => { const button = event.target.closest("[data-catalog-action]"); if (button) catalogAction(button.dataset.catalogAction, button.dataset.id); });
  $("#save-print-settings").addEventListener("click", savePrintSettings);
  $("#export-backup").addEventListener("click", exportBackup);
  $("#import-backup").addEventListener("click", importBackup);
  $("#print-profiles").addEventListener("input", (event) => {
    const card = event.target.closest(".profile-card"); if (!card) return;
    const x = Number($("[data-profile-field='offsetX']", card)?.value) || 0;
    const y = Number($("[data-profile-field='offsetY']", card)?.value) || 0;
    const dot = $(".offset-dot", card); if (dot) { dot.style.setProperty("--offset-x", `${Math.max(-20, Math.min(20, x)) * 2}px`); dot.style.setProperty("--offset-y", `${Math.max(-20, Math.min(20, y)) * 2}px`); }
  });
  $("#close-print-preview").addEventListener("click", () => $("#print-dialog").close());
  $("#print-now").addEventListener("click", printNow);
  document.addEventListener("keydown", (event) => {
    if (event.key === "F2") { event.preventDefault(); switchView("billing"); }
    if (event.key === "F3") { event.preventDefault(); switchView("history"); }
    if (event.key === "F4") { event.preventDefault(); switchView("catalog"); }
    if (event.key === "F5") { event.preventDefault(); switchView("printing"); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (currentView === "billing") saveDraft(); else if (currentView === "printing") savePrintSettings(); }
  });
}

function updateClock() {
  const date = new Date();
  $("#sidebar-clock").textContent = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  $("#today-label").textContent = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).format(date);
}

async function initialize() {
  await loadStore();
  store.catalogItems ||= [];
  store.documents ||= [];
  store.printProfiles ||= defaultProfiles();
  store.settings ||= { organizationName: "门诊部", documentTitle: "门诊项目明细清单", defaultPrintProfileId: store.printProfiles[0]?.id };
  const blankProfile = store.printProfiles.find((profile) => profile.id === "blank-241x140");
  if (blankProfile && blankProfile.paperWidthMm === 241 && blankProfile.paperHeightMm === 140
    && blankProfile.marginsMm?.left === 8 && blankProfile.marginsMm?.right === 8
    && blankProfile.marginsMm?.top === 6 && blankProfile.marginsMm?.bottom === 6) {
    blankProfile.marginsMm = { top: 0, right: 15.5, bottom: 0, left: 15.5 };
  }
  currentDocument = createFreshDocument();
  bindEvents();
  updateClock(); setInterval(updateClock, 30_000);
  await loadPrinterOptions();
  renderBilling(); renderCatalog(); renderHistory(); renderLocalSettings(); renderPrintProfiles();
}

initialize().catch((error) => {
  console.error(error);
  document.body.innerHTML = `<main style="padding:40px;font-family:serif"><h1>收费台启动失败</h1><p>${escapeHtml(error?.message || "未知错误")}</p><p>请重新启动应用；本机数据不会因此删除。</p></main>`;
});
