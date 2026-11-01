/* build_skill.mjs — 把定稿的链路配置生成一个独立子技能包
 * 用法：node scripts/build_skill.mjs --link <链路名> --config <配置目录>
 * 前提：配置目录里有 链路就绪.json（人工核对过映射才算定稿，没过不让生成）
 * 产物：produced/<链路>/ 自包含包（自己的 run/lib/act + 配置），zip/ 里出包，台账登记一行
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipDir, listEntries } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 ? process.argv[i + 1] : d; };

const link = arg('link');
const configDir = arg('config');
if (!link || !configDir) { console.error('用法：node scripts/build_skill.mjs --link <链路名> --config <配置目录>'); process.exit(1); }
if (!fs.existsSync(path.join(configDir, '链路就绪.json'))) {
  console.error('配置没定稿（缺 链路就绪.json）：先跑 analyze.py --confirm 走完人工核对');
  process.exit(1);
}

/* 子包 = 同款结构，run.mjs 按 scripts/.. 找 assets，原样搬就能跑 */
const outDir = path.join(ROOT, 'produced', link);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, '配置'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'scripts', 'lib'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'run.mjs'), path.join(outDir, 'scripts', 'run.mjs'));
for (const f of ['cdp.mjs', 'tableread.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', 'lib', f), path.join(outDir, 'scripts', 'lib', f));
fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'assets', 'act.js'), path.join(outDir, 'assets', 'act.js'));
for (const f of fs.readdirSync(configDir)) fs.copyFileSync(path.join(configDir, f), path.join(outDir, '配置', f));

/* 子包 SKILL.md：直给接手 AI/同事的执行规程 */
const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'child.SKILL.md'), 'utf8');
const mappingRows = fs.readFileSync(path.join(outDir, '配置', '映射字典.csv'), 'utf8').split(/\r?\n/).filter(l => l.trim());
fs.writeFileSync(path.join(outDir, 'SKILL.md'),
  tpl.replace(/{{链接名}}/g, link).replace('{{映射表}}', mappingRows.slice(0, 12).join('\n').replace(/</g, '‹')), 'utf8');
fs.copyFileSync(path.join(ROOT, 'templates', '一键跑.md'), path.join(outDir, '一键跑.md'));

/* 台账：一链路一行，重跑覆盖同名行。口径：每次生成 = 版本 +1、失败次数清零（新包新账，
   历史失败在 logs/失败台账.log 里永远可查）——重录升级和普通重生成走同一条规则，不搞分支 */
const ledgerFile = path.join(ROOT, '台账.csv');
const ledger = fs.existsSync(ledgerFile)
  ? fs.readFileSync(ledgerFile, 'utf8').split(/\r?\n/).filter(l => l.trim())
  : ['链路,版本,状态,最后变动,zip,失败次数,备注'];
const row = ledger.findIndex(l => l.startsWith(link + ','));
const prevVer = row >= 0 ? (Number(String(ledger[row].split(',')[1] || '').replace(/^v/, '')) || 0) : 0;
const version = String(prevVer + 1);
const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
const zipInfo = zipDir(outDir, link, path.join(ROOT, 'zip', `${link}_v${version}_${stamp.slice(0, 10).replace(/-/g, '')}.zip`));
const line = `${link},${version},已生成,${stamp},${path.basename(zipInfo.path)},0,`;
if (row >= 0) ledger[row] = line; else ledger.push(line);
fs.writeFileSync(ledgerFile, ledger.join('\r\n') + '\r\n', 'utf8');

const check = listEntries(zipInfo.path);
console.log(`✓ 子技能已生成：${outDir}`);
console.log(`  包：${zipInfo.path}（${zipInfo.files} 个文件，回读验证 ${check.length} 条）`);
console.log(`  下一步：真实跑一轮 node produced/${link}/scripts/run.mjs --config 配置 --go`);
console.log(`  跑通后：node scripts/manage.mjs pass --link ${link}（记 verified，下次生成自动升版）`);
