---
name: skill-forge
description: 万物录制工厂——把任何重复的浏览器操作（后台取数→贴在线表格、链接到链接、按钮到按钮）录一次，自动分析出唯一键/字段映射/路由，人工核对后生成独立可复用的子技能包；网页改版失败自动标 broken，失败 3 次整条重录升级。当用户说「录制这个流程」「把这个搬运做成自动化」「又失败了升级一下」「清理旧包」时用。
---

# skill-forge：万物录制工厂

**一句话**：你像平时一样操作一遍浏览器 → 工厂录下 UI 动作 + 粘贴流 + 下载 + 接口 → 推断出「唯一键 + 字段映射 + 路由」→ 你勾选确认 → 生成一个能自己跑的子技能包。

设计原则（定死的，别偏）：

1. **不写死任何链路假设**——唯一键、字段叫法、贴到哪，全是每链路一份配置；机器识别不了的问你一次，答案固化复用。
2. **映射第一依据是值不是列名**——源列和粘贴块按值对齐（数字/文本逐行命中）；列名相同只算加分，名不同值相同照样映射但标"待核"。
3. **一切推断必须过人工核对表**——没确认过的不许生成子包。
4. **取列只按列名走同义字典，绝不按位置**——后台导出字段顺序怎么打乱都不影响。
5. **数据安检三件套**：贴前预览（--go 才真贴）、唯一键重复整轮停、贴完回读少一行都算失败。

## 六步流程

| 步 | 命令 | 产出 |
|---|---|---|
| ① 录 | `node scripts/record.mjs --url <后台入口> --name <链路名>` | `recordings/<链路名>_*.rec.json`（换页自动补注入，长链路不断流） |
| ② 析 | `python -I scripts/analyze.py --recording <上一步文件> --source <下载的导出表> --out <草稿目录> --link <链路名>` | 映射字典草稿 + 唯一键候选 + 定位库 + 路由表 + `映射核对表.html` |
| ③ 核 | 打开核对表勾选 → 导出 `映射核对_确认.csv` → `python -I scripts/analyze.py --confirm <确认csv> --out <草稿目录>` | 定稿配置 + `链路就绪.json` |
| ④ 生 | `node scripts/build_skill.mjs --link <链路名> --config <草稿目录>` | `produced/<链路名>/` 独立包 + `zip/` 出包 + 台账登记 |
| ⑤ 跑 | `node produced/<链路>/scripts/run.mjs --config 配置 --source <新导出> [--go]` | 预览/真跑 + 回读复核；跑通后 `node scripts/manage.mjs pass --link <链路名>` |
| ⑥ 管 | `node scripts/manage.mjs status | fail --link X --phenomenon "…" | clean` | 台账、broken 标记、7 天清旧包 |

在线表格的**目标 URL / sheet / 粘贴落点**在 `配置/路由表.csv` 里补：一行 = 一个账户贴到哪个表格哪个 sheet。新增搬运关系 = 加一行，脚本永不改。

## 什么算"跑通"（别自己放宽）

- 预览列头与值和源表对得上；
- 真跑后输出「复核通过」：**每一行的唯一键值都能在目标页回读见到**；
- 差一行 = 失败 → `manage.mjs fail`，不许默默跳过。

## 网页改版怎么升级（闭环）

run.mjs 找不到元素 → 退出码 3 + 提示 → `manage.mjs fail --link X --phenomenon "…"` 记一笔；
**失败 ≥3 次 → 整条重录**（①→④再来一遍，新的动作序列会 diff 出变化点），重新生成后版本 +1、旧 zip 由 `clean` 按周清掉，台账行永远保留。

## 旧包口径

本工厂产物 zip **只留最近 7 天**（`manage.mjs clean`，默认 7 天），回滚窗口一周；台账.csv 保留全部版本历史。其他项目的版本 zip 链照旧不删，两套规矩并行。

## 与 web-automation-sop 的关系

`assets/recorder.js` 是 web-automation-sop 录制器的 v2（保留六级定位链，新增粘贴/复制/下载抓取）。链路生命周期统一走 台账.csv。包里不带 .cmd/.ps1 可执行件——上传平台普遍拒收，命令速查见 `templates/一键跑.md`。

## Pitfalls（血泪前置）

- **CDP evaluate 顶层 return 会静默不执行**——lib/cdp.mjs 已强制 IIFE 包裹，自己加代码别绕过它。
- **Chrome 136+ 默认配置开不了调试口**——ensureChrome 一律独立 profile（`chrome_profile/`），首次要人登录一次，之后长期有效。
- **一任务一端口**——录制/执行默认 18801，与别的会话撞车就 `--port 18802`，绝不共用。
- **gbk 的 csv 读不了**（Node 无原生 gbk）——导出用 xlsx，或先另存 UTF-8，报错信息里会说。
- **在线表格各家 DOM 都不一样**——`act.js` 的合成粘贴是通用路（paste 事件 + execCommand 双保险），具体表格若不认，给它加一个适配函数放 assets/adapters/，别改 run.mjs 主干。
- **粘贴落点靠 落点best 定位**——录制时点过的格子会带定位进定位库；路由表里没填落点就贴到当前聚焦格（先手点一下目标 sheet 的起始格再跑）。
- **本包 .md/.csv/.json 一律无 BOM**；.cmd/.ps1 可执行件平台拒收，包里不带。
- Node 24+（WebSocket/fetch 全局）、Python 3 标准库，**零第三方依赖**。

## 依赖与实测状态

- **已实测（离线全链，2026-10-31）**：样例源表+样例录制 → 唯一键/直贴/分列/公式全部识别 → 人工确认定稿 → build 生成子包 → 子包 `--source` 预览输出正确；台账 生成/标失败/重生成升版 闭环也验过。自测：`python -I test/run_offline_test.py`（7 断言）+ `node test/run_node_test.mjs`（8 断言），从干净状态开箱即跑。
- **待现场联调（需要真实后台和在线表格）**：record.mjs 的浏览器会话、定位库回放、act.js 合成粘贴在各家在线表格的命中情况。第一次对某在线表格跑通后，把适配结论记进 references/。
- 参考项目结论（千问/Kimi 插件、browser-use、Skyvern、Stagehand、Chrome DevTools Recorder、影刀各自借了什么）：`references/参考项目笔记.md`
