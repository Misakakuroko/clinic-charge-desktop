import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRINT_PROFILES,
  DOCUMENT_STATUS,
  DomainError,
  calculateLineAmount,
  confirmDocument,
  copyAsDraft,
  createDraftDocument,
  createEmptyStore,
  createId,
  formatMoney,
  isDocumentLocked,
  matchesDocument,
  nextSerial,
  normalizeStore,
  parseMoneyToCents,
  searchDocuments,
  toChineseUppercase,
  validateDocument,
  voidDocument,
} from "../src/domain.mjs";

const fixedNow = "2026-08-17T09:30:00.000Z";

function idSequence() {
  let index = 0;
  return (prefix) => `${prefix}-${++index}`;
}

function catalogItem(overrides = {}) {
  return {
    id: "item-treatment",
    code: "ZL001",
    name: "治疗费",
    specification: "1次",
    unit: "次",
    unitPriceCents: 10000,
    category: "治疗",
    summaryCategory: "诊疗收入",
    enabled: true,
    extraMeta: { source: "本院项目库" },
    createdAt: fixedNow,
    updatedAt: fixedNow,
    ...overrides,
  };
}

function validDraft(overrides = {}) {
  return createDraftDocument(
    {
      serial: "202608170001",
      patientName: "匿名患者",
      patientType: "自费",
      doctorName: "测试医生",
      operatorName: "收费员甲",
      organizationName: "测试门诊部",
      businessDate: "2026-08-17",
      statisticsStartDate: "2026-08-01",
      statisticsEndDate: "2026-08-18",
      lines: [{ item: catalogItem(), quantity: 2 }],
      ...overrides,
    },
    { now: fixedNow, idFactory: idSequence() },
  );
}

test("空数据结构包含四个持久化域，默认打印配置互不共享引用", () => {
  const first = createEmptyStore();
  const second = createEmptyStore();

  assert.equal(first.version, 1);
  assert.deepEqual(first.catalogItems, []);
  assert.deepEqual(first.documents, []);
  assert.equal(first.printProfiles.length, 2);
  assert.equal(first.settings.defaultPrintProfileId, "blank-241x140");
  assert.equal(DEFAULT_PRINT_PROFILES[0].paperWidthMm, 241);

  first.printProfiles[0].offsetMm.x = 9;
  assert.equal(second.printProfiles[0].offsetMm.x, 0);
  assert.equal(DEFAULT_PRINT_PROFILES[0].offsetMm.x, 0);
});

test("运行时归一化修复缺失容器、金额和派生合计，同时保留扩展字段", () => {
  const normalized = normalizeStore({
    version: 999,
    catalogItems: [
      {
        id: "item-1",
        name: "小活络片",
        unitPrice: "15.64",
        summaryCategory: "药品收入",
        customField: "保留",
      },
    ],
    documents: [
      {
        id: "doc-1",
        serial: "202608170001",
        status: "draft",
        patientName: "匿名患者",
        patientType: " 自费 ",
        doctorName: " 测试医生 ",
        operatorName: " 收费员甲 ",
        organizationName: " 测试门诊部 ",
        businessDate: "2026-08-17",
        statisticsStartDate: "20260801",
        statisticsEndDate: "2026-08-18",
        locked: true,
        totalCents: 1,
        lines: [
          {
            id: "line-1",
            quantity: 4,
            itemSnapshot: {
              id: "item-1",
              name: "小活络片",
              unitPriceCents: 1564,
              batchHint: "完整快照扩展字段",
            },
          },
        ],
      },
    ],
    settings: { organizationName: "测试门诊部", custom: 7 },
  });

  assert.equal(normalized.version, 1);
  assert.equal(normalized.catalogItems[0].unitPriceCents, 1564);
  assert.equal(normalized.catalogItems[0].customField, "保留");
  assert.equal(normalized.catalogItems[0].summaryCategory, "药品收入");
  assert.equal(normalized.documents[0].locked, false);
  assert.equal(normalized.documents[0].patientType, "自费");
  assert.equal(normalized.documents[0].doctorName, "测试医生");
  assert.equal(normalized.documents[0].operatorName, "收费员甲");
  assert.equal(
    normalized.documents[0].organizationName,
    "测试门诊部",
  );
  assert.equal(normalized.documents[0].statisticsStartDate, "2026-08-01");
  assert.equal(normalized.documents[0].statisticsEndDate, "2026-08-18");
  assert.equal(normalized.documents[0].lines[0].amountCents, 6256);
  assert.equal(normalized.documents[0].totalCents, 6256);
  assert.equal(
    normalized.documents[0].lines[0].itemSnapshot.batchHint,
    "完整快照扩展字段",
  );
  assert.equal(normalized.settings.custom, 7);
});

test("ID 带有安全前缀且可注入时间与随机源进行确定性测试", () => {
  const id = createId("Document / 收费", {
    now: 0,
    randomUUID: () => "12345678-1234-1234-1234-123456789abc",
  });
  assert.equal(id, "document_0_1234567812341234");
  assert.notEqual(createId("line"), createId("line"));
});

test("金额始终按整数分解析和格式化，不接受三位小数", () => {
  assert.equal(parseMoneyToCents("￥1,234.50"), 123450);
  assert.equal(parseMoneyToCents(".5"), 50);
  assert.equal(parseMoneyToCents(-0.01), -1);
  assert.equal(formatMoney(123450), "1234.50");
  assert.equal(formatMoney(-105, { symbol: true, thousands: true }), "-¥1.05");
  assert.throws(() => parseMoneyToCents("1.005"), DomainError);
  assert.throws(() => formatMoney(1.2), /整数分/);
});

test("数量乘法支持三位以内小数并在半分时按绝对值四舍五入", () => {
  assert.equal(calculateLineAmount(1564, 4), 6256);
  assert.equal(calculateLineAmount(101, "1.5"), 152);
  assert.equal(calculateLineAmount(1, "0.5"), 1);
  assert.throws(() => calculateLineAmount(100, 0), /大于零/);
  assert.throws(() => calculateLineAmount(100, "1.0001"), /三位小数/);
});

test("人民币大写覆盖整数、角分、跨万补零和零金额", () => {
  assert.equal(toChineseUppercase(0), "零元整");
  assert.equal(toChineseUppercase(40000), "肆佰元整");
  assert.equal(toChineseUppercase(81956), "捌佰壹拾玖元伍角陆分");
  assert.equal(toChineseUppercase(100100), "壹仟零壹元整");
  assert.equal(toChineseUppercase(100000001), "壹佰万元零壹分");
  assert.equal(toChineseUppercase(-101), "负壹元零壹分");
});

test("流水号按业务日期取最大已用序号，作废单据也不会释放号码", () => {
  const documents = [
    { serial: "202608170002", status: "confirmed" },
    { serial: "202608170009", status: "voided" },
    { serial: "202608180099", status: "draft" },
    { serial: "bad" },
  ];
  assert.equal(nextSerial(documents, "2026-08-17"), "202608170010");
  assert.equal(nextSerial({ documents }, "20260818"), "202608180100");
  assert.throws(
    () => nextSerial([{ serial: "202608179999" }], "2026-08-17"),
    /已用完/,
  );
});

test("建单时深拷贝完整项目快照，之后修改项目库不会改写历史明细", () => {
  const item = catalogItem();
  const draft = createDraftDocument(
    {
      serial: "202608170001",
      patientName: "匿名患者",
      businessDate: "2026-08-17",
      lines: [{ item, quantity: 2 }],
    },
    { now: fixedNow, idFactory: idSequence() },
  );

  item.name = "已改名";
  item.extraMeta.source = "已修改";
  assert.equal(draft.lines[0].itemSnapshot.name, "治疗费");
  assert.equal(draft.lines[0].itemSnapshot.summaryCategory, "诊疗收入");
  assert.equal(draft.lines[0].itemSnapshot.extraMeta.source, "本院项目库");
  assert.equal(draft.lines[0].amountCents, 20000);
  assert.equal(draft.totalCents, 20000);
});

test("单据校验同时约束流水日期、项目金额和合计金额", () => {
  const draft = validDraft();
  assert.deepEqual(validateDocument(draft), { valid: true, errors: [] });

  const tampered = structuredClone(draft);
  tampered.serial = "202608180001";
  tampered.lines[0].amountCents = 1;
  tampered.totalCents = 1;
  const validation = validateDocument(tampered);
  assert.equal(validation.valid, false);
  assert.deepEqual(
    validation.errors.map((error) => error.code),
    ["serial_date_mismatch", "amount_mismatch"],
  );
});

test("确认后锁定；作废保留原单；重开创建新草稿、新行 ID 和独立快照", () => {
  const draft = validDraft();
  const confirmed = confirmDocument(draft, {
    now: "2026-08-17T10:00:00.000Z",
    confirmedBy: "收费员甲",
  });

  assert.equal(draft.status, DOCUMENT_STATUS.DRAFT);
  assert.equal(confirmed.status, DOCUMENT_STATUS.CONFIRMED);
  assert.equal(confirmed.locked, true);
  assert.equal(isDocumentLocked(confirmed), true);
  assert.throws(() => confirmDocument(confirmed), /只有草稿/);
  assert.throws(() => voidDocument(confirmed, { reason: "" }), /作废原因/);

  const voided = voidDocument(confirmed, {
    now: "2026-08-17T10:05:00.000Z",
    voidedBy: "收费员甲",
    reason: "录入项目错误",
  });
  assert.equal(confirmed.status, DOCUMENT_STATUS.CONFIRMED);
  assert.equal(voided.status, DOCUMENT_STATUS.VOIDED);
  assert.equal(voided.voidReason, "录入项目错误");

  const reopened = copyAsDraft(voided, {
    serial: "202608170002",
    now: "2026-08-17T10:06:00.000Z",
    idFactory: (() => {
      let index = 100;
      return (prefix) => `${prefix}-${++index}`;
    })(),
  });
  assert.equal(reopened.status, DOCUMENT_STATUS.DRAFT);
  assert.equal(reopened.locked, false);
  assert.equal(reopened.copiedFromDocumentId, voided.id);
  assert.equal(reopened.patientType, "自费");
  assert.equal(reopened.doctorName, "测试医生");
  assert.equal(reopened.operatorName, "收费员甲");
  assert.equal(reopened.organizationName, "测试门诊部");
  assert.equal(reopened.statisticsStartDate, "2026-08-01");
  assert.equal(reopened.statisticsEndDate, "2026-08-18");
  assert.notEqual(reopened.id, voided.id);
  assert.notEqual(reopened.lines[0].id, voided.lines[0].id);
  reopened.lines[0].itemSnapshot.name = "新草稿修改";
  assert.equal(voided.lines[0].itemSnapshot.name, "治疗费");
  assert.deepEqual(validateDocument(reopened), { valid: true, errors: [] });
});

test("姓名模糊、日期闭区间和流水号片段可以组合查询", () => {
  const documents = [
    {
      id: "a",
      patientName: "王 园园",
      businessDate: "2026-08-17",
      serial: "202608170024",
    },
    {
      id: "b",
      patientName: "王晓明",
      businessDate: "2026-08-18",
      serial: "202608180001",
    },
  ];

  const filters = {
    name: "园园",
    dateFrom: "2026-08-17",
    dateTo: "2026-08-17",
    serial: "0024",
  };
  assert.equal(matchesDocument(documents[0], filters), true);
  assert.equal(matchesDocument(documents[1], filters), false);
  assert.deepEqual(searchDocuments(documents, filters).map((item) => item.id), ["a"]);
  assert.equal(matchesDocument(documents[0], { dateFrom: "无效日期" }), false);
});
