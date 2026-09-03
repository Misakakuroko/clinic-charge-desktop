import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [html, app, preload] = await Promise.all([
  readFile(new URL("src/index.html", root), "utf8"),
  readFile(new URL("src/app.mjs", root), "utf8"),
  readFile(new URL("electron/preload.cjs", root), "utf8"),
]);

test("桌面页面包含离线 CSP 与四个核心工作区", () => {
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src 'none'/);
  for (const view of ["billing", "history", "catalog", "printing"]) {
    assert.match(html, new RegExp(`data-view-panel="${view}"`));
  }
  assert.doesNotMatch(html, /https?:\/\//i);
});

test("答卷确认的抬头、项目和组合查询字段在界面中可用", () => {
  for (const id of [
    "patient-name", "charge-date", "patient-type", "operator-name",
    "medical-institution", "doctor-name", "statistics-from", "statistics-to",
    "catalog-code", "catalog-name", "catalog-specification", "catalog-unit",
    "catalog-price", "catalog-category", "catalog-summary-category",
    "filter-name", "filter-from", "filter-to", "filter-serial",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少界面字段 #${id}`);
  }
  assert.match(app, /organizationName/);
  assert.match(app, /summaryCategory/);
});

test("本机存储、备份与打印只通过受限 preload API 暴露", () => {
  for (const method of ["loadData", "saveData", "exportBackup", "importBackup", "getPrinters", "print"]) {
    assert.match(preload, new RegExp(`${method}:`));
  }
  assert.match(html, /id="export-backup"/);
  assert.match(html, /id="import-backup"/);
  assert.match(html, /不作为报销凭证/);
});
