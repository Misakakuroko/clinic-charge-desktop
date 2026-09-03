# 门诊收费录入打印软件

这是根据需求答卷制作的 Windows 单机离线首版。它不联网，不开具具有法律效力的医疗收费票据，只生成内部收费或治疗清单。

## 直接下载 Windows 版

[下载最新 Windows x64 离线包](https://github.com/Misakakuroko/clinic-charge-desktop/releases/latest/download/ClinicCharge-Windows-x64.zip)

下载后请完整解压，再双击文件夹内的 `ClinicCharge.exe`。不要只把 EXE 单独复制出来。

首版闭环：

- 维护收费项目目录，也允许本单临时项目；
- 录入患者姓名和收费明细，按单价 × 数量计算两位小数金额；
- 保存项目快照，目录后来改名或改价不会影响历史单据；
- 草稿确认后锁定，可查看、补打、作废和作废重开；
- 按患者姓名、收款日期和内部流水号组合查询；
- 提供空白纸完整打印与 90×90 mm 预印票据套打两套校准档案；
- 桌面版数据保存在当前 Windows 用户的应用数据目录，并支持手动导入、导出备份。

## 开发运行

```bash
npm install
npm run check
npm start
```

## 生成 Windows 便携版

```bash
npm run package:win
```

输出位于 `release/ClinicCharge-win32-x64/`。整个目录复制到 Windows 10/11 x64 电脑后，双击 `ClinicCharge.exe` 即可运行，无需联网安装依赖。

## 打印定稿前仍需现场材料

- 确认 241×140 mm 是纸张外尺寸、210×140 mm 是否为有效内容区；
- 90×90 mm 无遮挡空白票据；
- 匿名合格成品照片；
- 富士通 DPK800 铭牌或完整型号后缀照片；
- 实际纸张配尺照片。

在材料到位前，页面尺寸和 X/Y 偏移均可调整，但不能宣称已经通过 DPK800 实机套打验收。
