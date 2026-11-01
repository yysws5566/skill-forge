/* record.mjs — 录制会话驱动：起浏览器 → 注入录制器 → 你正常操作 → 收一条完整录制
 * 用法：
 *   node scripts/record.mjs --url https://xxx [--name 链路名] [--port 18801] [--minutes 15]
 * 结束：Ctrl+C 或到时 → recordings/<name>_<时间>.rec.json
 * 关键改进（对 (54) 版）：换页/SPA 跳转丢了 window.__SOP 时自动重新注入，
 * 动作在驱动侧按 injectedAt#seq 合并去重，长链路不再断流。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureChrome, Cdp, watchDownloads, watchNetwork, sleep } from './lib/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const url = arg('url');
const name = arg('name', 'link_' + new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const port = Number(arg('port', '18801'));
const minutes = Number(arg('minutes', '15'));

if (!url) {
  console.error('用法：node scripts/record.mjs --url <起始页> [--name 链路名] [--port 18801] [--minutes 15]');
  process.exit(1);
}

await ensureChrome({ port, mode: 'watch' });
const cdp = await Cdp.attach({ port, urlPart: url.replace(/^https?:\/\//, '').split('/')[0] });
await cdp.send('Page.navigate', { url }).catch(() => {});
await cdp.enableSession();
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow', downloadPath: path.join(ROOT, 'recordings', '_downloads', String(Date.now()))
});

const recorderPath = path.join(ROOT, 'assets', 'recorder.js');
const netReqs = watchNetwork(cdp);
const dl = watchDownloads(cdp, path.join(ROOT, 'recordings', '_downloads'));
const merged = new Map(); // key = injectedAt#seq → action（跨页合并的全量动作流）

let sessionEnd = false;
process.on('SIGINT', () => { console.log('\n收到停止信号，正在收尾…'); sessionEnd = true; });

console.log(`● 录制中：正常操作浏览器即可（${minutes} 分钟后自动收，Ctrl+C 提前收）`);
console.log(`  标签：${cdp.target.url}`);

async function pollOnce() {
  const state = await cdp.evalJs(`(function () {
    try {
      if (!window.__SOP || !window.__SOP_start) return { missing: true };
      if (!window.__SOP.recording) { __SOP_start(); }
      return { dump: __SOP_dump() };
    } catch (e) { return { error: String(e) }; }
  })()`, { awaitPromise: false }).catch(e => ({ error: String(e) }));

  if (!state || state.missing || state.error) {
    // 换页丢了 → 重新注入（内容本身是 IIFE，注入即就位）
    await cdp.injectFile(recorderPath).catch(() => {});
    await cdp.evalJs('__SOP_start()', { awaitPromise: false }).catch(() => {});
    return;
  }
  if (!state.dump) return;
  let d;
  try { d = JSON.parse(state.dump); } catch { return; }
  for (const a of d.actions || []) {
    merged.set(`${d.injectedAt}#${a.seq}`, { ...a, page: d.url, pageTitle: d.title });
  }
}

const t0 = Date.now();
while (!sessionEnd && Date.now() - t0 < minutes * 60000) {
  await pollOnce();
  await sleep(1500);
}

try { await cdp.evalJs('__SOP_stop()', { awaitPromise: false }); } catch { /* 页面可能已关 */ }

const actions = [...merged.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(e => e[1]);
const out = {
  meta: {
    name, url, port, finishedAt: new Date().toISOString(),
    counts: {
      total: actions.length,
      paste: actions.filter(a => a.type === 'paste').length,
      copy: actions.filter(a => a.type === 'copy').length,
      download: actions.filter(a => a.type === 'download').length,
      click: actions.filter(a => a.type === 'click').length,
      fill: actions.filter(a => a.type === 'fill').length
    }
  },
  actions,
  downloads: dl.files,
  network: netReqs
};

const outFile = path.join(ROOT, 'recordings', `${name}_${Date.now()}.rec.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1), 'utf8');
cdp.close();

console.log(`\n✓ 录制完成 → ${outFile}`);
console.log(`  动作 ${out.meta.counts.total} 条（粘贴 ${out.meta.counts.paste} / 复制 ${out.meta.counts.copy} / 下载 ${out.meta.counts.download} / 点击 ${out.meta.counts.click}）`);
console.log('下一步：node 里的分析器出映射草稿 →');
console.log(`  python -I scripts/analyze.py --recording "${outFile}" --source <下载的源表> --out 配置草稿目录`);
