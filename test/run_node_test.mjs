/* run_node_test.mjs — Node 侧自测：表格读取（csv+xlsx）+ zip 打包回读
 * 用法：node test/run_node_test.mjs   （xlsx 样例由 python 测试生成，没有就现场造一个最小合法包）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCsv, readXlsx, toNum } from '../scripts/lib/tableread.mjs';
import { zipStore, listEntries } from '../scripts/lib/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, '_fixture');
fs.mkdirSync(FIX, { recursive: true });
const checks = [];
const ok = (name, cond) => { checks.push([name, cond]); console.log((cond ? '✓ ' : '✗ ') + name); };

/* 1) csv 读取（utf-8-sig） */
const csvPath = path.join(FIX, '源表.csv');
if (fs.existsSync(csvPath)) {
  const t = readCsv(csvPath);
  ok('csv 表头', t.headers.join(',') === '日期,视频id,名称,消耗,展示次数');
  ok('csv 行数=4', t.rows.length === 4);
  ok('数字口径', toNum('1,200.50') === 1200.5);
} else {
  ok('csv（跳过：先跑 python 测试生成样例）', true);
}

/* 2) 最小 xlsx 现场造一个再读（inlineStr 写法） */
const xlsxPath = path.join(FIX, 'mini.xlsx');
if (!fs.existsSync(xlsxPath)) {
  // 最简结构：只放我们两个解析器都认的部件（不给 Excel 打开用，给解析器用）
  const entries = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook><sheets><sheet name="数据"/></sheets></workbook>'],
    ['xl/worksheets/sheet1.xml',
      '<?xml version="1.0"?><worksheet><sheetData>' +
      '<row><c r="A1" t="inlineStr"><is><t>日期</t></is></c><c r="B1" t="inlineStr"><is><t>消耗</t></is></c></row>' +
      '<row><c r="A2" t="inlineStr"><is><t>2026-10-30</t></is></c><c r="B2"><v>1200.5</v></c></row>' +
      '</sheetData></worksheet>']
  ];
  // 复用 zipStore 打出合法 zip 结构
  const { zipStore: zs } = await import('../scripts/lib/zip.mjs');
  zs(entries.map(([name, data]) => ({ name, data: Buffer.from(data, 'utf8') })), xlsxPath);
}
const xt = readXlsx(xlsxPath);
ok('xlsx 表头', xt.headers.join(',') === '日期,消耗');
ok('xlsx 数值单元格', xt.rows[0]['消耗'] === '1200.5');

/* 3) zip 打包 → 回读验证条目名 */
const zipPath = path.join(FIX, 'roundtrip.zip');
zipStore([
  { name: 'skill-forge/SKILL.md', data: Buffer.from('# 测试中文条目名', 'utf8') },
  { name: 'skill-forge/配置/映射字典.csv', data: Buffer.from('源列,目标列\n消耗,花费\n', 'utf8') }
], zipPath);
const names = listEntries(zipPath);
ok('zip 回读 2 条', names.length === 2);
ok('zip 条目用 / 分隔且无反斜杠', names.every(n => !n.includes('\\')));
ok('zip 中文条目名读回一致', names.includes('skill-forge/配置/映射字典.csv'));

/* 4) 大 zip（超过 64KB EOCD 搜索窗）回读——tail 变子视图后偏移重复加的坑 */
const bigPath = path.join(FIX, 'big.zip');
zipStore([
  { name: 'a/big.bin', data: Buffer.alloc(70000, 7) },
  { name: 'a/明细.csv', data: Buffer.from('日期,消耗\n2026-10-31,1200.50\n', 'utf8') }
], bigPath);
const bigNames = listEntries(bigPath);
ok('大zip（>64KB 窗口）回读 2 条', bigNames.length === 2 && bigNames.includes('a/明细.csv'));

const bad = checks.filter(([, c]) => !c).map(([n]) => n);
if (bad.length) { console.error('\nnode test 失败：' + bad.join('；')); process.exit(1); }
console.log(`\nnode test 全过（${checks.length}/${checks.length}）`);
