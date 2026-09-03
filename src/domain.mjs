export const STORE_VERSION = 1;

export const DOCUMENT_STATUS = Object.freeze({
  DRAFT: "draft",
  CONFIRMED: "confirmed",
  VOIDED: "voided",
});

const DEFAULT_SETTINGS = Object.freeze({
  organizationName: "",
  documentTitle: "门诊项目明细清单",
  defaultPrintProfileId: "blank-241x140",
});

const PRINT_PROFILE_SEED = [
  {
    id: "blank-241x140",
    name: "空白纸 241 × 140 mm",
    mode: "blank",
    paperWidthMm: 241,
    paperHeightMm: 140,
    marginsMm: { top: 6, right: 8, bottom: 6, left: 8 },
    offsetMm: { x: 0, y: 0 },
    isDefault: true,
  },
  {
    id: "preprinted-90x90",
    name: "预印票据套打 90 × 90 mm",
    mode: "preprinted",
    paperWidthMm: 90,
    paperHeightMm: 90,
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    offsetMm: { x: 0, y: 0 },
    isDefault: false,
  },
];

export const DEFAULT_PRINT_PROFILES = deepFreeze(cloneJson(PRINT_PROFILE_SEED));

export class DomainError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function createEmptyStore() {
  return {
    version: STORE_VERSION,
    catalogItems: [],
    documents: [],
    printProfiles: cloneJson(DEFAULT_PRINT_PROFILES),
    settings: { ...DEFAULT_SETTINGS },
  };
}

export function normalizeStore(value) {
  const source = isRecord(value) ? value : {};
  const fallback = createEmptyStore();

  const catalogItems = uniqueById(
    arrayOrEmpty(source.catalogItems).map((item) => normalizeCatalogItem(item)),
  );
  const documents = uniqueById(
    arrayOrEmpty(source.documents).map((document) => normalizeDocument(document)),
  );

  const suppliedProfiles = arrayOrEmpty(source.printProfiles)
    .filter(isRecord)
    .map((profile) => normalizePrintProfile(profile));
  const profilesById = new Map(
    fallback.printProfiles.map((profile) => [profile.id, profile]),
  );
  for (const profile of suppliedProfiles) profilesById.set(profile.id, profile);
  const printProfiles = [...profilesById.values()];

  const suppliedSettings = isRecord(source.settings)
    ? cloneJson(source.settings)
    : {};
  const requestedDefault = text(
    suppliedSettings.defaultPrintProfileId,
    DEFAULT_SETTINGS.defaultPrintProfileId,
  );
  const defaultPrintProfileId = printProfiles.some(
    (profile) => profile.id === requestedDefault,
  )
    ? requestedDefault
    : printProfiles[0].id;

  for (const profile of printProfiles) {
    profile.isDefault = profile.id === defaultPrintProfileId;
  }

  return {
    version: STORE_VERSION,
    catalogItems,
    documents,
    printProfiles,
    settings: {
      ...suppliedSettings,
      organizationName: text(suppliedSettings.organizationName),
      documentTitle: text(
        suppliedSettings.documentTitle,
        DEFAULT_SETTINGS.documentTitle,
      ),
      defaultPrintProfileId,
    },
  };
}

export function createId(prefix = "id", options = {}) {
  const safePrefix =
    text(prefix, "id")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "id";
  const nowValue = options.now instanceof Date ? options.now.getTime() : options.now;
  const timestamp = Number.isFinite(Number(nowValue))
    ? Number(nowValue)
    : Date.now();
  const uuidFactory =
    typeof options.randomUUID === "function"
      ? options.randomUUID
      : globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  const entropy = uuidFactory
    ? uuidFactory().replaceAll("-", "").slice(0, 16)
    : Math.floor((options.random ?? Math.random)() * Number.MAX_SAFE_INTEGER)
        .toString(36)
        .padStart(10, "0")
        .slice(0, 16);
  return `${safePrefix}_${Math.trunc(timestamp).toString(36)}_${entropy}`;
}

export function parseMoneyToCents(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new DomainError("INVALID_MONEY", "金额必须是数字或文本");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new DomainError("INVALID_MONEY", "金额必须是有限数字");
  }

  const normalized = String(value)
    .trim()
    .replace(/^(?:人民币|RMB)\s*/i, "")
    .replace(/[¥￥,，\s]/g, "");
  const match = /^([+-]?)(?:(\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/.exec(
    normalized,
  );
  if (!match) {
    throw new DomainError("INVALID_MONEY", "金额最多保留两位小数");
  }

  const sign = match[1] === "-" ? -1 : 1;
  const yuan = BigInt(match[2] || "0");
  const fractionText = (match[3] ?? match[4] ?? "").padEnd(2, "0");
  const cents = (yuan * 100n + BigInt(fractionText || "0")) * BigInt(sign);
  const result = Number(cents);
  if (!Number.isSafeInteger(result)) {
    throw new DomainError("MONEY_OUT_OF_RANGE", "金额超出安全范围");
  }
  return result;
}

export function formatMoney(cents, options = {}) {
  assertCents(cents);
  const normalizedOptions =
    typeof options === "boolean" ? { symbol: options } : options;
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const yuan = Math.floor(absolute / 100);
  const fraction = String(absolute % 100).padStart(2, "0");
  const yuanText = normalizedOptions.thousands
    ? yuan.toLocaleString("en-US")
    : String(yuan);
  const symbol = normalizedOptions.symbol ? "¥" : "";
  return `${negative ? "-" : ""}${symbol}${yuanText}.${fraction}`;
}

export function calculateLineAmount(unitPriceCents, quantity) {
  assertCents(unitPriceCents);
  const { numerator, denominator } = parseQuantity(quantity);
  if (numerator <= 0n) {
    throw new DomainError("INVALID_QUANTITY", "数量必须大于零");
  }

  const product = BigInt(unitPriceCents) * numerator;
  const absolute = product < 0n ? -product : product;
  const rounded = (absolute * 2n + denominator) / (denominator * 2n);
  const signed = product < 0n ? -rounded : rounded;
  const result = Number(signed);
  if (!Number.isSafeInteger(result)) {
    throw new DomainError("AMOUNT_OUT_OF_RANGE", "行金额超出安全范围");
  }
  return result;
}

export function toChineseUppercase(cents) {
  assertCents(cents);
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const integer = Math.floor(absolute / 100);
  const jiao = Math.floor((absolute % 100) / 10);
  const fen = absolute % 10;

  let result = `${integerToChinese(integer)}元`;
  if (jiao === 0 && fen === 0) {
    result += "整";
  } else {
    if (jiao > 0) result += `${CHINESE_DIGITS[jiao]}角`;
    if (fen > 0) {
      if (jiao === 0 && integer > 0) result += "零";
      result += `${CHINESE_DIGITS[fen]}分`;
    }
  }
  return `${negative ? "负" : ""}${result}`;
}

export function nextSerial(storeOrDocuments = [], businessDate = new Date()) {
  const documents = Array.isArray(storeOrDocuments)
    ? storeOrDocuments
    : arrayOrEmpty(storeOrDocuments?.documents);
  const date = normalizeBusinessDate(businessDate);
  if (!date) throw new DomainError("INVALID_DATE", "无法生成流水号：日期无效");
  const prefix = date.replaceAll("-", "");
  let largest = 0;
  const pattern = new RegExp(`^${prefix}(\\d{4})$`);

  for (const document of documents) {
    const match = pattern.exec(text(document?.serial));
    if (match) largest = Math.max(largest, Number(match[1]));
  }
  if (largest >= 9999) {
    throw new DomainError("SERIAL_EXHAUSTED", `${date} 的流水号已用完`);
  }
  return `${prefix}${String(largest + 1).padStart(4, "0")}`;
}

export function normalizeCatalogItem(value, options = {}) {
  const source = isRecord(value) ? cloneJson(value) : {};
  const now = isoTimestamp(options.now);
  const unitPriceCents = coerceCents(
    source.unitPriceCents,
    source.unitPrice ?? source.price,
  );
  return {
    ...source,
    id: text(source.id) || createId("item", options),
    code: text(source.code),
    name: text(source.name),
    specification: text(source.specification ?? source.spec),
    unit: text(source.unit),
    unitPriceCents,
    category: text(source.category),
    summaryCategory: text(source.summaryCategory),
    enabled: source.enabled !== false,
    createdAt: validIso(source.createdAt) || now,
    updatedAt: validIso(source.updatedAt) || validIso(source.createdAt) || now,
  };
}

export function createDocumentLine(catalogItem, quantity = 1, options = {}) {
  if (!isRecord(catalogItem)) {
    throw new DomainError("INVALID_CATALOG_ITEM", "项目资料无效");
  }
  const snapshot = normalizeCatalogItem(catalogItem, options);
  if (!snapshot.name) {
    throw new DomainError("INVALID_CATALOG_ITEM", "项目名称不能为空");
  }
  const normalizedQuantity = quantityToNumber(quantity);
  const unitPriceCents = snapshot.unitPriceCents;
  const itemSnapshot = cloneJson(snapshot);
  return {
    id: callIdFactory(options.idFactory, "line"),
    catalogItemId: snapshot.id,
    itemSnapshot,
    quantity: normalizedQuantity,
    unitPriceCents,
    amountCents: calculateLineAmount(unitPriceCents, normalizedQuantity),
  };
}

export function createDraftDocument(input = {}, options = {}) {
  const source = isRecord(input) ? input : {};
  const now = isoTimestamp(options.now);
  const businessDate =
    normalizeBusinessDate(source.businessDate ?? source.date) ||
    normalizeBusinessDate(options.now ?? new Date());
  const lines = arrayOrEmpty(source.lines).map((line) =>
    normalizeLineInput(line, options),
  );

  return {
    id: text(source.id) || callIdFactory(options.idFactory, "document"),
    serial: text(source.serial),
    status: DOCUMENT_STATUS.DRAFT,
    locked: false,
    patientName: text(source.patientName ?? source.name),
    patientType: text(source.patientType),
    doctorName: text(source.doctorName),
    operatorName: text(source.operatorName),
    organizationName: text(source.organizationName),
    businessDate,
    statisticsStartDate: normalizeBusinessDate(source.statisticsStartDate),
    statisticsEndDate: normalizeBusinessDate(source.statisticsEndDate),
    lines,
    totalCents: sumLineAmounts(lines),
    note: text(source.note),
    printProfileId: text(source.printProfileId),
    createdAt: validIso(source.createdAt) || now,
    updatedAt: now,
    confirmedAt: null,
    confirmedBy: "",
    voidedAt: null,
    voidedBy: "",
    voidReason: "",
    copiedFromDocumentId: text(source.copiedFromDocumentId) || null,
  };
}

export function normalizeDocument(value, options = {}) {
  const source = isRecord(value) ? cloneJson(value) : {};
  const status = Object.values(DOCUMENT_STATUS).includes(source.status)
    ? source.status
    : DOCUMENT_STATUS.DRAFT;
  const now = isoTimestamp(options.now);
  const lines = arrayOrEmpty(source.lines).map((line) =>
    normalizeLineInput(line, options),
  );
  const createdAt = validIso(source.createdAt) || now;
  const confirmedAt = validIso(source.confirmedAt) || null;
  const voidedAt = validIso(source.voidedAt) || null;

  return {
    ...source,
    id: text(source.id) || callIdFactory(options.idFactory, "document"),
    serial: text(source.serial),
    status,
    locked: status !== DOCUMENT_STATUS.DRAFT,
    patientName: text(source.patientName ?? source.name),
    patientType: text(source.patientType),
    doctorName: text(source.doctorName),
    operatorName: text(source.operatorName),
    organizationName: text(source.organizationName),
    businessDate: normalizeBusinessDate(source.businessDate ?? source.date),
    statisticsStartDate: normalizeBusinessDate(source.statisticsStartDate),
    statisticsEndDate: normalizeBusinessDate(source.statisticsEndDate),
    lines,
    totalCents: sumLineAmounts(lines),
    note: text(source.note),
    printProfileId: text(source.printProfileId),
    createdAt,
    updatedAt: validIso(source.updatedAt) || createdAt,
    confirmedAt,
    confirmedBy: text(source.confirmedBy),
    voidedAt,
    voidedBy: text(source.voidedBy),
    voidReason: text(source.voidReason),
    copiedFromDocumentId: text(source.copiedFromDocumentId) || null,
  };
}

export function validateDocument(document) {
  const errors = [];
  if (!isRecord(document)) {
    return {
      valid: false,
      errors: [validationError("", "invalid_document", "单据数据无效")],
    };
  }

  const status = document.status;
  if (!Object.values(DOCUMENT_STATUS).includes(status)) {
    errors.push(validationError("status", "invalid_status", "单据状态无效"));
  }

  const businessDate = normalizeBusinessDate(document.businessDate);
  if (!businessDate) {
    errors.push(validationError("businessDate", "required", "请选择收费日期"));
  }

  const serial = text(document.serial);
  if (!/^\d{12}$/.test(serial)) {
    errors.push(
      validationError(
        "serial",
        "invalid_serial",
        "流水号必须为 YYYYMMDD 加四位序号",
      ),
    );
  } else if (businessDate && !serial.startsWith(businessDate.replaceAll("-", ""))) {
    errors.push(
      validationError("serial", "serial_date_mismatch", "流水号日期与收费日期不一致"),
    );
  }

  if (!text(document.patientName)) {
    errors.push(validationError("patientName", "required", "请输入姓名"));
  }

  if (!Array.isArray(document.lines) || document.lines.length === 0) {
    errors.push(validationError("lines", "required", "请至少添加一个收费项目"));
  } else {
    const seenLineIds = new Set();
    document.lines.forEach((line, index) => {
      const path = `lines.${index}`;
      if (!isRecord(line)) {
        errors.push(validationError(path, "invalid_line", "收费项目数据无效"));
        return;
      }
      const lineId = text(line.id);
      if (!lineId) {
        errors.push(validationError(`${path}.id`, "required", "收费项目缺少标识"));
      } else if (seenLineIds.has(lineId)) {
        errors.push(
          validationError(`${path}.id`, "duplicate", "收费项目标识不能重复"),
        );
      } else {
        seenLineIds.add(lineId);
      }

      if (!isRecord(line.itemSnapshot)) {
        errors.push(
          validationError(
            `${path}.itemSnapshot`,
            "required",
            "收费项目必须保留完整快照",
          ),
        );
      } else {
        if (!text(line.itemSnapshot.id)) {
          errors.push(
            validationError(
              `${path}.itemSnapshot.id`,
              "required",
              "项目快照缺少标识",
            ),
          );
        }
        if (!text(line.itemSnapshot.name)) {
          errors.push(
            validationError(
              `${path}.itemSnapshot.name`,
              "required",
              "项目快照缺少名称",
            ),
          );
        }
        if (
          text(line.catalogItemId) &&
          text(line.itemSnapshot.id) &&
          text(line.catalogItemId) !== text(line.itemSnapshot.id)
        ) {
          errors.push(
            validationError(
              `${path}.catalogItemId`,
              "snapshot_id_mismatch",
              "项目标识与项目快照不一致",
            ),
          );
        }
        if (
          Number.isSafeInteger(line.unitPriceCents) &&
          line.itemSnapshot.unitPriceCents !== line.unitPriceCents
        ) {
          errors.push(
            validationError(
              `${path}.itemSnapshot.unitPriceCents`,
              "snapshot_price_mismatch",
              "项目单价与项目快照不一致",
            ),
          );
        }
      }

      if (!Number.isSafeInteger(line.unitPriceCents) || line.unitPriceCents < 0) {
        errors.push(
          validationError(
            `${path}.unitPriceCents`,
            "invalid_money",
            "项目单价必须是非负整数分",
          ),
        );
      }

      let expectedAmount;
      try {
        expectedAmount = calculateLineAmount(line.unitPriceCents, line.quantity);
      } catch {
        errors.push(
          validationError(`${path}.quantity`, "invalid_quantity", "项目数量必须大于零"),
        );
      }
      if (
        expectedAmount !== undefined &&
        (!Number.isSafeInteger(line.amountCents) || line.amountCents !== expectedAmount)
      ) {
        errors.push(
          validationError(
            `${path}.amountCents`,
            "amount_mismatch",
            "项目金额与单价、数量不一致",
          ),
        );
      }
    });
  }

  const expectedTotal = Array.isArray(document.lines)
    ? document.lines.reduce(
        (sum, line) =>
          sum + (Number.isSafeInteger(line?.amountCents) ? line.amountCents : 0),
        0,
      )
    : 0;
  if (
    !Number.isSafeInteger(document.totalCents) ||
    document.totalCents !== expectedTotal
  ) {
    errors.push(
      validationError("totalCents", "total_mismatch", "合计金额与项目明细不一致"),
    );
  }

  if (status === DOCUMENT_STATUS.DRAFT && document.locked === true) {
    errors.push(validationError("locked", "draft_locked", "草稿不能处于锁定状态"));
  }
  if (status === DOCUMENT_STATUS.CONFIRMED) {
    if (document.locked !== true) {
      errors.push(
        validationError("locked", "confirmed_unlocked", "已确认单据必须锁定"),
      );
    }
    if (!validIso(document.confirmedAt)) {
      errors.push(
        validationError("confirmedAt", "required", "已确认单据缺少确认时间"),
      );
    }
  }
  if (status === DOCUMENT_STATUS.VOIDED) {
    if (document.locked !== true) {
      errors.push(validationError("locked", "voided_unlocked", "已作废单据必须锁定"));
    }
    if (!validIso(document.confirmedAt)) {
      errors.push(
        validationError("confirmedAt", "required", "已作废单据缺少原确认时间"),
      );
    }
    if (!validIso(document.voidedAt)) {
      errors.push(
        validationError("voidedAt", "required", "已作废单据缺少作废时间"),
      );
    }
    if (!text(document.voidReason)) {
      errors.push(
        validationError("voidReason", "required", "已作废单据缺少作废原因"),
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function confirmDocument(document, options = {}) {
  if (document?.status !== DOCUMENT_STATUS.DRAFT) {
    throw new DomainError("DOCUMENT_LOCKED", "只有草稿可以确认");
  }
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new DomainError("DOCUMENT_INVALID", "单据尚未填写完整", validation.errors);
  }
  const now = isoTimestamp(options.now);
  return {
    ...normalizeDocument(document, options),
    status: DOCUMENT_STATUS.CONFIRMED,
    locked: true,
    updatedAt: now,
    confirmedAt: now,
    confirmedBy: text(options.confirmedBy),
    voidedAt: null,
    voidedBy: "",
    voidReason: "",
  };
}

export function voidDocument(document, options = {}) {
  const normalizedOptions =
    typeof options === "string" ? { reason: options } : options;
  if (document?.status !== DOCUMENT_STATUS.CONFIRMED) {
    throw new DomainError("DOCUMENT_NOT_CONFIRMED", "只有已确认单据可以作废");
  }
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new DomainError("DOCUMENT_INVALID", "单据数据不完整，无法作废", validation.errors);
  }
  const reason = text(normalizedOptions.reason);
  if (!reason) {
    throw new DomainError("VOID_REASON_REQUIRED", "请填写作废原因");
  }
  const now = isoTimestamp(normalizedOptions.now);
  return {
    ...normalizeDocument(document, normalizedOptions),
    status: DOCUMENT_STATUS.VOIDED,
    locked: true,
    updatedAt: now,
    voidedAt: now,
    voidedBy: text(normalizedOptions.voidedBy),
    voidReason: reason,
  };
}

export function copyAsDraft(document, options = {}) {
  if (document?.status !== DOCUMENT_STATUS.VOIDED) {
    throw new DomainError("DOCUMENT_NOT_VOIDED", "只有已作废单据可以重开为新草稿");
  }
  const validation = validateDocument(document);
  if (!validation.valid) {
    throw new DomainError(
      "DOCUMENT_INVALID",
      "原单据数据不完整，无法重开",
      validation.errors,
    );
  }
  const businessDate =
    normalizeBusinessDate(options.businessDate) || document.businessDate;
  const serial =
    text(options.serial) ||
    (options.documents || options.store
      ? nextSerial(options.documents || options.store, businessDate)
      : "");

  return createDraftDocument(
    {
      serial,
      patientName: document.patientName,
      patientType: document.patientType,
      doctorName: document.doctorName,
      operatorName: document.operatorName,
      organizationName: document.organizationName,
      businessDate,
      statisticsStartDate: document.statisticsStartDate,
      statisticsEndDate: document.statisticsEndDate,
      lines: document.lines.map((line) => ({
        itemSnapshot: cloneJson(line.itemSnapshot),
        quantity: line.quantity,
      })),
      note: document.note,
      printProfileId: document.printProfileId,
      copiedFromDocumentId: document.id,
    },
    options,
  );
}

export function matchesDocument(document, filters = {}) {
  if (!isRecord(document)) return false;
  const source = isRecord(filters) ? filters : {};
  const nameQuery = normalizeSearchText(source.name ?? source.patientName);
  const serialQuery = normalizeSerialSearch(source.serial);
  const patientName = normalizeSearchText(document.patientName);
  const serial = normalizeSerialSearch(document.serial);
  if (nameQuery && !patientName.includes(nameQuery)) return false;
  if (serialQuery && !serial.includes(serialQuery)) return false;

  const documentDate = normalizeBusinessDate(document.businessDate);
  const dateFrom = source.dateFrom
    ? normalizeBusinessDate(source.dateFrom)
    : source.startDate
      ? normalizeBusinessDate(source.startDate)
      : "";
  const dateTo = source.dateTo
    ? normalizeBusinessDate(source.dateTo)
    : source.endDate
      ? normalizeBusinessDate(source.endDate)
      : "";
  if ((source.dateFrom || source.startDate) && !dateFrom) return false;
  if ((source.dateTo || source.endDate) && !dateTo) return false;
  if ((dateFrom || dateTo) && !documentDate) return false;
  if (dateFrom && documentDate < dateFrom) return false;
  if (dateTo && documentDate > dateTo) return false;
  return true;
}

export function searchDocuments(documents, filters = {}) {
  return arrayOrEmpty(documents).filter((document) =>
    matchesDocument(document, filters),
  );
}

export function isDocumentLocked(document) {
  return document?.status !== DOCUMENT_STATUS.DRAFT || document?.locked === true;
}

const CHINESE_DIGITS = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const SMALL_UNITS = ["仟", "佰", "拾", ""];
const LARGE_UNITS = ["", "万", "亿", "兆"];

function integerToChinese(integer) {
  if (integer === 0) return "零";
  const groups = [];
  let remaining = integer;
  while (remaining > 0) {
    groups.unshift(remaining % 10000);
    remaining = Math.floor(remaining / 10000);
  }
  if (groups.length > LARGE_UNITS.length) {
    throw new DomainError("MONEY_OUT_OF_RANGE", "金额超出人民币大写支持范围");
  }

  let result = "";
  let zeroPending = false;
  groups.forEach((group, index) => {
    const unitIndex = groups.length - 1 - index;
    if (group === 0) {
      if (result) zeroPending = true;
      return;
    }
    if (result && (zeroPending || group < 1000) && !result.endsWith("零")) {
      result += "零";
    }
    result += `${fourDigitGroupToChinese(group)}${LARGE_UNITS[unitIndex]}`;
    zeroPending = false;
  });
  return result;
}

function fourDigitGroupToChinese(group) {
  const divisors = [1000, 100, 10, 1];
  let result = "";
  let zeroPending = false;
  divisors.forEach((divisor, index) => {
    const digit = Math.floor(group / divisor) % 10;
    if (digit === 0) {
      if (result && group % divisor !== 0) zeroPending = true;
      return;
    }
    if (zeroPending) result += "零";
    result += `${CHINESE_DIGITS[digit]}${SMALL_UNITS[index]}`;
    zeroPending = false;
  });
  return result;
}

function normalizeLineInput(value, options = {}) {
  const source = isRecord(value) ? cloneJson(value) : {};
  const itemSource = isRecord(source.itemSnapshot)
    ? source.itemSnapshot
    : isRecord(source.item)
      ? source.item
      : isRecord(source.catalogItem)
        ? source.catalogItem
        : source;
  const snapshot = normalizeCatalogItem(itemSource, options);
  const unitPriceCents =
    source.unitPriceCents !== undefined && source.unitPriceCents !== null
      ? coerceCents(source.unitPriceCents, source.unitPrice)
      : source.unitPrice !== undefined && source.unitPrice !== null
        ? parseMoneyToCents(source.unitPrice)
        : snapshot.unitPriceCents;
  snapshot.unitPriceCents = unitPriceCents;
  const quantity = quantityToNumber(source.quantity ?? 1);
  const { item: _item, catalogItem: _catalogItem, ...lineFields } = source;
  return {
    ...lineFields,
    id: text(source.id) || callIdFactory(options.idFactory, "line"),
    catalogItemId: text(source.catalogItemId ?? snapshot.id),
    itemSnapshot: cloneJson(snapshot),
    quantity,
    unitPriceCents,
    amountCents: calculateLineAmount(unitPriceCents, quantity),
  };
}

function normalizePrintProfile(value) {
  const source = cloneJson(value);
  const mode = source.mode === "preprinted" ? "preprinted" : "blank";
  return {
    ...source,
    id: text(source.id) || createId("print-profile"),
    name: text(source.name, mode === "blank" ? "空白纸" : "预印票据套打"),
    mode,
    paperWidthMm: positiveNumber(source.paperWidthMm, mode === "blank" ? 241 : 90),
    paperHeightMm: positiveNumber(source.paperHeightMm, mode === "blank" ? 140 : 90),
    marginsMm: normalizeBox(source.marginsMm),
    offsetMm: {
      x: finiteNumber(source.offsetMm?.x, 0),
      y: finiteNumber(source.offsetMm?.y, 0),
    },
    isDefault: source.isDefault === true,
  };
}

function normalizeBox(value) {
  const source = isRecord(value) ? value : {};
  return {
    top: nonNegativeNumber(source.top, 0),
    right: nonNegativeNumber(source.right, 0),
    bottom: nonNegativeNumber(source.bottom, 0),
    left: nonNegativeNumber(source.left, 0),
  };
}

function normalizeBusinessDate(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (ymd && isValidDateParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))) {
      return trimmed;
    }
    const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
    if (
      compact &&
      isValidDateParts(Number(compact[1]), Number(compact[2]), Number(compact[3]))
    ) {
      return `${compact[1]}-${compact[2]}-${compact[3]}`;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isValidDateParts(year, month, day) {
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function parseQuantity(value) {
  const normalized = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match) {
    throw new DomainError("INVALID_QUANTITY", "数量最多保留三位小数");
  }
  const fraction = match[2] || "";
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(match[1]) * denominator + BigInt(fraction || "0");
  return { numerator, denominator };
}

function quantityToNumber(value) {
  const { numerator, denominator } = parseQuantity(value);
  if (numerator <= 0n) {
    throw new DomainError("INVALID_QUANTITY", "数量必须大于零");
  }
  const result = Number(numerator) / Number(denominator);
  if (!Number.isFinite(result) || result > 999999) {
    throw new DomainError("INVALID_QUANTITY", "数量超出允许范围");
  }
  return result;
}

function coerceCents(centsValue, yuanValue) {
  if (Number.isSafeInteger(centsValue)) return centsValue;
  if (typeof centsValue === "string" && /^-?\d+$/.test(centsValue.trim())) {
    const result = Number(centsValue);
    if (Number.isSafeInteger(result)) return result;
  }
  if (yuanValue !== undefined && yuanValue !== null && yuanValue !== "") {
    try {
      return parseMoneyToCents(yuanValue);
    } catch {
      return 0;
    }
  }
  return 0;
}

function assertCents(value) {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("INVALID_CENTS", "金额必须使用整数分保存");
  }
}

function sumLineAmounts(lines) {
  const total = lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (!Number.isSafeInteger(total)) {
    throw new DomainError("AMOUNT_OUT_OF_RANGE", "合计金额超出安全范围");
  }
  return total;
}

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function validIso(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function callIdFactory(factory, prefix) {
  return typeof factory === "function" ? text(factory(prefix)) || createId(prefix) : createId(prefix);
}

function validationError(path, code, message) {
  return { path, code, message };
}

function normalizeSearchText(value) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/g, "");
}

function normalizeSerialSearch(value) {
  return text(value).normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value, fallback) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function positiveNumber(value, fallback) {
  const result = finiteNumber(value, fallback);
  return result > 0 ? result : fallback;
}

function nonNegativeNumber(value, fallback) {
  const result = finiteNumber(value, fallback);
  return result >= 0 ? result : fallback;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      result[key] = cloneJson(item);
    }
    return result;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
