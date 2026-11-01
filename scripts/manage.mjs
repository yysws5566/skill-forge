/* manage.mjs — 工厂台账管理：状态 / 标失败 / 记跑通 / 清旧包
 * 用法：
 *   node scripts/manage.mjs status
 *   node scripts/manage.mjs fail    --link X [--phenomenon "元素找不到"] [--rootcause "平台改版"] [--fix "改了L5"]
 *   node scripts/manage.mjs pass    --link X            # 真跑通才许记
 *   node scripts/manage.mjs clean   [--days 7]          # 用户的口径：zip 只留一周，台账行永远留
 * 闭环规则：失败 ≥3 次 → 提示整条重录（record → analyze → 核对 → build），这就是"网页改版自动升级"的人工起点
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = path.join(ROOT, '台账.csv');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };

function load() {
  if (!fs.existsSync(LEDGER)) return [['链路', '版本', '状态', '最后变动', 'zip', '失败次数', '备注']];
  return fs.readFileSync(LEDGER, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()).map(l => l.split(','));
}
function save(rows) {
  fs.writeFileSync(LEDGER, rows.map(r => r.join(',')).join('\r\n') + '\r\n', 'utf8');
}
function findRow(rows, link) {
  const i = rows.findIndex(r => r[0] === link);
  if (i < 0) { console.error(`台账里没有链路「${link}」（先跑 build_skill.mjs 生成）`); process.exit(1); }
  return i;
}

const cmd = process.argv[2];
const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');

if (cmd === 'status') {
  const rows = load();
  console.log(rows.map(r => r.join(' | ')).join('\n'));
  const broken = rows.slice(1).filter(r => r[2] === 'broken');
  if (broken.length) console.log(`\n⚠ ${broken.length} 条 broken，处理顺序：重录(record.mjs) → 分析(analyze.py) → 核对 → 重新生成(build_skill.mjs)`);
  process.exit(0);
}

if (cmd === 'fail') {
  const link = arg('link');
  const rows = load();
  const i = findRow(rows, link);
  rows[i][2] = 'broken';
  rows[i][3] = stamp;
  rows[i][5] = String(Number(rows[i][5] || 0) + 1);
  rows[i][6] = [arg('phenomenon', ''), arg('rootcause', ''), arg('fix', '')].filter(Boolean).join('；').replace(/,/g, '，').slice(0, 200);
  save(rows);
  fs.appendFileSync(path.join(ROOT, 'logs', '失败台账.log'), `${stamp}\t${link}\t${arg('phenomenon', '')}\t${arg('rootcause', '')}\n`, 'utf8');
  console.log(`已记失败（第 ${rows[i][5]} 次）：${link}`);
  if (Number(rows[i][5]) >= 3) console.log('≥3 次：这条链路该整条重录升级了——node scripts/record.mjs --url <入口> --name ' + link);
  process.exit(0);
}

if (cmd === 'pass') {
  const link = arg('link');
  const rows = load();
  const i = findRow(rows, link);
  rows[i][2] = 'verified';
  rows[i][3] = stamp;
  save(rows);
  console.log(`已记跑通：${link}（下次 build_skill 会升版本号）`);
  process.exit(0);
}

if (cmd === 'clean') {
  const days = Number(arg('days', '7'));
  const zipDir = path.join(ROOT, 'zip');
  if (!fs.existsSync(zipDir)) { console.log('没有 zip 目录，无事可清'); process.exit(0); }
  const cut = Date.now() - days * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(zipDir)) {
    const p = path.join(zipDir, f);
    if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); removed++; console.log(`删 ${f}（超过 ${days} 天）`); }
  }
  console.log(removed ? `清理完成：删 ${removed} 个` : '没有过期 zip');
  console.log('台账行不动——版本历史永远在 台账.csv 里');
  process.exit(0);
}

console.error('用法：node scripts/manage.mjs status | fail --link X [--phenomenon …] | pass --link X | clean [--days 7]');
process.exit(1);
