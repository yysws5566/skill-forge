/* cdp.mjs — CDP 底仓（纯 Node 零依赖，Node 24 自带 WebSocket/fetch）
 * 本机惯例（来自 jzt-report / 方舟 / 建单元三包的实测）：
 *   - Chrome 136+ 禁止默认配置开调试口 → 必须独立 user-data-dir
 *   - 新开标签要用 PUT /json/new?<url>（GET 已被禁）
 *   - evaluate 一律 IIFE 包裹：顶层 return 会让整段静默不执行（CDP 大坑）
 *   - 一任务一端口一 profile，绝不与他人共用 18801
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CHROME_CANDIDATES = [
  process.env.CHROME_EXE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : ''
].filter(Boolean);

export async function portAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/* 确保一台调试 Chrome 活着。mode=watch 前台可见（录制/要用户操作），mode=bg 屏幕外（纯自动化） */
export async function ensureChrome({ port = 18801, profile, mode = 'watch', launch = true } = {}) {
  if (await portAlive(port)) return { port, launched: false };
  if (!launch) throw new Error(`调试口 ${port} 不通且未允许拉起浏览器`);
  const exe = CHROME_CANDIDATES.find(p => fs.existsSync(p));
  if (!exe) throw new Error('找不到 chrome.exe，装 Chrome 或设 CHROME_EXE 环境变量');
  profile = profile || path.join(SKILL_ROOT, 'chrome_profile');
  fs.mkdirSync(profile, { recursive: true });
  // bg 的 -21333 坐标是实测过的"屏幕外"位置；要看人操作就用 watch 的正常坐标
  const pos = mode === 'bg' ? '--window-position=-21333,-21333' : '--window-position=40,40 --window-size=1280,860';
  const args = [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, pos,
    '--no-first-run', '--no-default-browser-check', '--restore-last-session=false', 'about:blank'
  ];
  spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await portAlive(port)) return { port, launched: true };
  }
  throw new Error(`Chrome 拉起后调试口 ${port} 仍不通（可能被占用或 profile 被锁）`);
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

/* 找/开一个页面标签。给了 urlPart 就找 URL 含它的旧标签，找不到开新的 */
export async function findPage({ port = 18801, url, urlPart, create = true } = {}) {
  const list = await listTargets(port);
  const pages = list.filter(t => t.type === 'page');
  let hit = urlPart ? pages.find(p => (p.url || '').includes(urlPart)) : pages[0];
  if (!hit && create) {
    const open = url || 'about:blank';
    // PUT：新版 Chrome 的 /json/new 只收 PUT（实测坑）
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(open)}`, { method: 'PUT' });
    hit = await r.json();
  }
  if (!hit) throw new Error('没有可用的页面标签');
  return hit;
}

/* CDP 会话：发命令 + 订阅事件 */
export class Cdp {
  constructor(wsUrl, targetInfo) {
    this.wsUrl = wsUrl; this.target = targetInfo;
    this.id = 0; this.pending = new Map(); this.handlers = new Map();
  }
  static async attach({ port = 18801, urlPart, url, create = true } = {}) {
    const t = await findPage({ port, urlPart, url, create });
    const c = new Cdp(t.webSocketDebuggerUrl, t);
    await c._open();
    return c;
  }
  async _open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((ok, bad) => {
      this.ws.onopen = ok;
      this.ws.onerror = () => bad(new Error(`连不上调试口：${this.wsUrl}`));
    });
    this.ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(`${m.error.message} (${m.method || m.id})`)) : res(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        for (const fn of this.handlers.get(m.method)) fn(m.params);
      }
    };
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }

  /* 求值：自动 IIFE 包裹 + 等待 Promise + 中文原样返回 */
  async evalJs(expression, { awaitPromise = true } = {}) {
    const wrapped = expression.trim().startsWith('(function') || expression.trim().startsWith('(async')
      ? expression : `(async function(){ return (${expression}); })()`;
    const r = await this.send('Runtime.evaluate', {
      expression: wrapped, returnByValue: true, awaitPromise
    });
    if (r.exceptionDetails) {
      throw new Error(`页面执行报错：${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result?.value;
  }

  /* 注入整个 js 文件（内容须是表达式形态，如 recorder.js 的 IIFE） */
  async injectFile(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');
    return this.evalJs(code, { awaitPromise: false });
  }

  async enableSession() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
  }
}

/* 下载管家：把本会话下载落到独立目录，收齐文件名与结束事件 */
export function watchDownloads(cdp, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // 不设这个，Chrome 会下到系统下载夹，dir 里的文件名就对不上了（jzt 实测坑）
  cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }).catch(() => {});
  const files = [];
  cdp.on('Page.downloadWillBegin', p => {
    files.push({ guid: p.guid, filename: p.suggestedFilename, at: Date.now(), done: false });
  });
  cdp.on('Page.downloadProgress', p => {
    const f = files.find(x => x.guid === p.guid);
    if (f && p.state === 'completed') f.done = true;
  });
  return {
    dir, files,
    async waitAll(timeoutMs = 120000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (files.length && files.every(f => f.done)) return files;
        await sleep(1000);
      }
      throw new Error(`等下载超时：${files.filter(f => !f.done).map(f => f.filename).join(', ') || '一个都没开始'}`);
    }
  };
}

/* 网络摘要：只记 XHR/Fetch 请求（找"同源接口直调"用），环形上限 600 条 */
export function watchNetwork(cdp) {
  const reqs = [];
  cdp.on('Network.requestWillBeSent', p => {
    if (!['XHR', 'Fetch'].includes(p.type)) return;
    if (reqs.length >= 600) reqs.shift();
    let body = '';
    if (p.request?.postData) body = String(p.request.postData).slice(0, 1500);
    reqs.push({ at: Date.now(), method: p.request.method, url: p.request.url.slice(0, 400), body });
  });
  return reqs;
}
