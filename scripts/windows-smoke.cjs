'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

async function rendererSmoke(phase) {
  const checks = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
    checks.push(message);
  };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 15000;
    do {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(message);
  };
  await waitFor(() => document.body.dataset.appReady === 'true', '收费界面初始化超时');
  const waitUntilIdle = () => waitFor(() => document.body.getAttribute('aria-busy') !== 'true', '界面操作未结束');
  const click = async (selector) => {
    await waitUntilIdle();
    const element = document.querySelector(selector);
    if (!element || element.disabled || element.closest('[inert]')) throw new Error(`按钮不可操作：${selector}`);
    element.click();
    await waitUntilIdle();
  };
  const chooseUnsaved = async (choice) => {
    await waitUntilIdle();
    document.querySelector('#new-document').click();
    await waitFor(() => document.querySelector('#unsaved-dialog')?.open, '新建清单未提示处理未保存内容');
    document.querySelector(`#unsaved-dialog [data-unsaved-choice="${choice}"]`).click();
    await waitFor(() => !document.querySelector('#unsaved-dialog').open, '未保存内容弹窗未关闭');
    await waitUntilIdle();
  };
  const addLine = async () => {
    const previousCount = document.querySelectorAll('#line-items tr').length;
    await click('#add-temp-line');
    await waitFor(() => document.querySelectorAll('#line-items tr').length === previousCount + 1, '临时项目没有添加到界面');
  };
  const preview = async () => {
    await click('#preview-document');
    await waitFor(() => document.querySelector('#print-dialog')?.open, '打印预览未打开');
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  };
  const api = window.clinicDesktop;
  assert(typeof api?.loadData === 'function' && typeof api?.saveData === 'function', '真实 preload 接口可用');
  assert(document.querySelector('#page-title')?.textContent === '收费开单', '收费开单页面已加载');
  assert(document.querySelector('#patient-name')?.getBoundingClientRect().width > 0, '姓名输入框可见');
  assert(getComputedStyle(document.querySelector('.app-shell')).display === 'grid', '本地样式已加载');
  assert(!document.querySelector('#storage-mode').textContent.includes('浏览器'), '连接桌面本地存储');

  const patientName = '自动化测试（非真实患者）';
  const input = (selector, value) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`缺少输入控件：${selector}`);
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  if (phase === 'write') {
    const before = await api.loadData();
    assert(!before.data || before.data.documents.length === 0, '测试数据目录为空');
    input('#patient-name', patientName);
    input('#medical-institution', '自动化测试机构');
    input('#doctor-name', '测试医生');
    await addLine();
    input('#line-items [data-field="name"]', '测试收费项目');
    input('#line-items [data-field="unitPrice"]', '15.64');
    input('#line-items [data-field="quantity"]', '4');
    await click('#save-draft');
    await waitFor(async () => {
      const loaded = await api.loadData();
      return loaded.data?.documents.some((entry) => entry.patientName === patientName && entry.totalCents === 6256);
    }, '通过界面保存的草稿未持久化');
    assert(document.querySelector('#total-amount').textContent.includes('62.56'), '界面按单价乘数量计算金额');
    const original = (await api.loadData()).data;
    for (const [field, invalidValue, corrected] of [
      ['unitPrice', 'abc', '15.64'],
      ['unitPrice', '', '15.64'],
      ['unitPrice', '1.005', '15.64'],
      ['quantity', '0', '4'],
      ['quantity', '1.0001', '4'],
    ]) {
      const selector = `#line-items [data-field="${field}"]`;
      input(selector, invalidValue);
      assert(document.querySelector(selector).getAttribute('aria-invalid') === 'true', `错误输入已标出：${field}=${JSON.stringify(invalidValue)}`);
      assert(document.querySelector('#total-amount').textContent.trim() === '—', '错误数字不会显示为有效收费金额');
      await click('#save-draft');
      assert(!document.querySelector('#billing-error').hidden, '保存错误数字时显示具体修正提示');
      assert(JSON.stringify((await api.loadData()).data) === JSON.stringify(original), '界面拒绝错误数字且保留原单据');
      input(selector, corrected);
      assert(document.querySelector(selector).getAttribute('aria-invalid') !== 'true', '数字修正后输入框恢复可用');
    }
    await click('#save-draft');
    const saved = (await api.loadData()).data;
    assert(saved.documents[0].totalCents === 6256, '错误输入修正后可以再次保存');
    const invalid = structuredClone(saved);
    invalid.documents[0].lines[0].quantity = 1.0001;
    for (const malformed of [{ hello: 'wrong file' }, invalid]) {
      let rejected = false;
      try { await api.saveData(malformed); } catch { rejected = true; }
      assert(rejected, '主进程拒绝不合法的保存数据');
    }
    assert(JSON.stringify((await api.loadData()).data) === JSON.stringify(saved), '拒绝错误数据后原草稿保持不变');

    await preview();
    assert(document.querySelector('#print-sheet .print-status')?.textContent.includes('草稿'), '草稿预览具有显著状态标识');
    assert(!document.querySelector('#print-now').disabled && document.querySelector('#print-warning').hidden, '普通单行清单可完整放入空白纸');
    await click('#close-print-preview');

    input('#document-note', '未保存切换保护测试');
    await chooseUnsaved('cancel');
    assert(document.querySelector('#patient-name').value === patientName && document.querySelector('#document-note').value === '未保存切换保护测试', '取消新建后保留当前未保存内容');
    assert(JSON.stringify((await api.loadData()).data) === JSON.stringify(saved), '取消新建不会意外写入或覆盖单据');
    await chooseUnsaved('save');
    assert(document.querySelector('#patient-name').value === '', '选择保存后成功新建空白清单');
    assert((await api.loadData()).data.documents[0].note === '未保存切换保护测试', '新建前已将旧清单的修改保存到磁盘');

    input('#patient-name', '自动化溢出测试（不落盘）');
    for (let index = 0; index < 30; index += 1) {
      await addLine();
      input('#line-items tr:last-child [data-field="name"]', `第 ${index + 1} 项合成收费项目，用于验证单页打印容量`);
    }
    await preview();
    assert(document.querySelector('#print-now').disabled, '过长清单已禁用打印按钮');
    assert(!document.querySelector('#print-warning').hidden && document.querySelector('#print-warning').textContent.includes('超出'), '过长清单显示明确的越界提示');
    await click('#close-print-preview');
    await chooseUnsaved('discard');
    assert((await api.loadData()).data.documents.length === 1, '放弃未保存的溢出测试清单不会增加历史记录');
  } else {
    const loaded = await api.loadData();
    const documentValue = loaded.data?.documents.find((entry) => entry.patientName === patientName);
    assert(documentValue?.totalCents === 6256 && documentValue.lines[0].quantity === 4, '退出重启后草稿和金额保持不变');
    assert(documentValue?.note === '未保存切换保护测试', '切换清单时保存的修改在重启后仍存在');
    await click('.nav-item[data-view="history"]');
    input('#filter-name', '自动化测试');
    document.querySelector('#history-filter').requestSubmit();
    await waitUntilIdle();
    await waitFor(() => document.querySelector('#history-rows')?.textContent.includes(patientName), '重启后的姓名查询未返回测试草稿');
    assert(document.querySelector('#history-rows').textContent.includes('62.56'), '历史查询展示正确金额');

    await click('#history-rows [data-history-action="edit"]');
    await waitFor(() => document.querySelector('#patient-name').value === patientName, '历史草稿未载入收费开单页');
    const changedDate = documentValue.businessDate === '2026-08-17' ? '2026-08-18' : '2026-08-17';
    input('#charge-date', changedDate);
    await click('#save-draft');
    const afterDateChange = (await api.loadData()).data;
    const revised = afterDateChange.documents.find((entry) => entry.id === documentValue.id);
    assert(afterDateChange.documents.length === 1 && revised?.businessDate === changedDate, '已保存草稿可修改收费日期并重新保存，不产生重复单据');
    assert(revised.serial.startsWith(changedDate.replaceAll('-', '')) && revised.totalCents === 6256, '修改收费日期后流水号同步且金额不变');

    const originalConfirm = window.confirm;
    let confirmAsked = false;
    try {
      window.confirm = () => { confirmAsked = true; return true; };
      await click('#confirm-document');
    } finally {
      window.confirm = originalConfirm;
    }
    assert(confirmAsked, '确认清单经过确认提示');
    assert((await api.loadData()).data.documents[0].status === 'confirmed' && document.querySelector('#patient-name').disabled, '确认清单后持久化为已确认并锁定输入');
    await click('.nav-item[data-view="history"]');
    await click('#history-rows [data-history-action="view"]');
    await waitFor(() => document.querySelector('#history-dialog').open, '历史详情未打开');
    document.querySelector('#history-actions [data-modal-action="void"]').click();
    await waitFor(() => document.querySelector('#void-dialog')?.open, '作废原因弹窗未打开');
    input('#void-reason', '自动化验收作废（非真实业务）');
    document.querySelector('#void-form').requestSubmit();
    await waitFor(() => !document.querySelector('#void-dialog').open, '提交原因后作废弹窗未关闭');
    await waitUntilIdle();
    const voided = (await api.loadData()).data.documents.find((entry) => entry.id === documentValue.id);
    assert(voided?.status === 'voided' && voided.voidReason === '自动化验收作废（非真实业务）', '作废状态和原因已保存');
    await click('.nav-item[data-view="billing"]');
    assert(document.querySelector('#patient-name').value === patientName && document.querySelector('#document-status').textContent.includes('已作废'), '开单页原当前单据同步为已作废');
    await preview();
    assert(document.querySelector('#print-sheet .print-status')?.textContent.includes('已作废'), '作废后从开单页预览原单据带有已作废标识');
    await click('#close-print-preview');
  }
  return checks;
}

async function runAppSmoke({ app, mainWindow, userDataPath }) {
  const phase = process.env.CLINIC_SMOKE_PHASE;
  let result;
  try {
    if (!['write', 'read'].includes(phase)) throw new Error('测试阶段无效');
    if (!process.argv.includes('--smoke-test') || path.resolve(process.env.CLINIC_SMOKE_USER_DATA || '') !== path.resolve(userDataPath)) {
      throw new Error('拒绝在非隔离数据目录运行测试');
    }
    const checks = await mainWindow.webContents.executeJavaScript(`(${rendererSmoke.toString()})(${JSON.stringify(phase)})`);
    const stats = await fs.stat(path.join(userDataPath, 'clinic-charge-data.json'));
    if (stats.size === 0) throw new Error('主进程没有写入实际数据文件');
    result = { ok: true, phase, checks, dataBytes: stats.size };
  } catch (error) {
    result = { ok: false, phase, error: error.message };
  }
  try {
    await fs.writeFile(path.join(userDataPath, `smoke-${phase}.json`), JSON.stringify(result, null, 2));
  } finally {
    app.exit(result.ok ? 0 : 1);
  }
}

async function runExecutable(executable, userDataPath, phase) {
  const environment = { ...process.env, CLINIC_SMOKE_USER_DATA: userDataPath, CLINIC_SMOKE_PHASE: phase };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--smoke-test'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk) => { output = (output + chunk.toString()).slice(-12000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Windows ${phase} 测试 60 秒内未退出。\n${output}`));
    }, 60000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); resolve(code); });
  });
  let report;
  try {
    report = JSON.parse(await fs.readFile(path.join(userDataPath, `smoke-${phase}.json`), 'utf8'));
  } catch {
    throw new Error(`Windows ${phase} 未生成验收报告（退出码 ${exitCode}）。\n${output}`);
  }
  if (exitCode !== 0 || !report.ok) throw new Error(`Windows ${phase} 验收失败：${report.error || exitCode}\n${output}`);
  return report;
}

async function main() {
  if (process.platform !== 'win32') throw new Error('请在 Windows 上运行实际打包程序验收。');
  const projectRoot = path.resolve(__dirname, '..');
  const executable = path.join(projectRoot, 'release', 'ClinicCharge-win32-x64', 'ClinicCharge.exe');
  await fs.access(executable);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'clinic-smoke-'));
  console.log(`使用隔离测试数据目录：${userDataPath}`);
  const reports = [];
  for (const phase of ['write', 'read']) {
    reports.push(await runExecutable(executable, userDataPath, phase));
    console.log(`${phase}：通过`);
  }
  await fs.writeFile(path.join(projectRoot, 'release', 'windows-smoke-report.json'), JSON.stringify({ ok: true, reports }, null, 2));
  console.log('Windows 打包程序启动、界面录入、IPC 校验、保存重启和历史查询通过。');
}

module.exports = { runAppSmoke };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
