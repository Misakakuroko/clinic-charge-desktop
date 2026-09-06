import test from 'node:test';
import assert from 'node:assert/strict';
import { ignorePackageFile } from '../scripts/package-windows.mjs';

test('Windows 打包包含运行入口、本地界面资产和显式验收脚本', () => {
  for (const file of ['', '/package.json', '/src', '/src/index.html', '/src/styles.css', '/src/app.mjs', '/src/domain.mjs', '/src/assets/icon.png', '/electron/main.cjs', '/electron/preload.cjs', '/electron/storage.cjs', '/scripts', '/scripts/windows-smoke.cjs']) {
    assert.equal(ignorePackageFile(file), false, file);
  }
});

test('Windows 打包不携带开发目录、报告、散落数据和环境文件', () => {
  for (const file of ['/release', '/release/ClinicCharge.exe', '/tests/domain.test.mjs', '/.github/workflows/windows.yml', '/.git/config', '/node_modules', '/scripts/package-windows.mjs', '/clinic-charge-data.json', '/backup.json', '/.env', '/.env.local', '/windows-smoke-report.json']) {
    assert.equal(ignorePackageFile(file), true, file);
  }
  assert.equal(ignorePackageFile('\\electron\\preload.cjs'), false);
  assert.equal(ignorePackageFile('\\release\\ClinicCharge.exe'), true);
});
