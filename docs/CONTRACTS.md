# worklog 实现契约（模块对齐基准）

本文件是并行实现各模块时的唯一对齐基准。数据形状的完整定义见
`docs/specs/2026-07-26-worklog-implementation-plan.md` 第 4 节（下称"实现方案"），
需求语义见 `docs/specs/2026-07-26-worklog-event-capture-daily-report-spec.md`（下称"设计规格"）。
冲突时以本文件为准（本文件已吸收两文档的待定决策落定结果）。

## 已落定的决策

1. 根目录 `~/.worklog`（环境变量 `WL_HOME` 覆盖），命令名 `wl`。与 CODEX_HOME 体系独立。
2. 默认结算节奏：**D+1 开工确认**。收工模式为显式可选，触发词"收工"。
3. 口头触发词："记一下"→note、"记个待办"→todo、"记个想法"→idea。
4. 概览语言 zh-CN 默认；LLM 模型经 `WORKLOG_MATCH_MODEL` 环境变量注入，代码与文档不硬编码模型名。
5. 用户机器上不存在 V1 memory.json（已核实），`import-v1` 命令仍实现但预期为空导入。

## 运行环境事实（本机已核实）

- 目标运行环境是 WSL Ubuntu / Linux。测试一律在 WSL 里跑：
  `wsl -d Ubuntu -e bash -c 'cd /mnt/d/Code/worklog && <命令>'`
  注意：不要在 Git Bash 里直接传 `/mnt/...` 参数（MSYS 会改写路径）；把路径放进引号内的 -c 字符串里。
- WSL 内有：node v22（nvm）、flock（util-linux）、python3；**jq 可能不存在**——
  热路径所有 jq 用法必须带 python3 回退（设计规格 FR-4 允许）。
- macOS 便携性按实现方案 §10：不用 `date -I`；flock 缺失时降级为纯 O_APPEND 追加。

## 代码风格

- Node：ESM、无分号、单引号、2 空格缩进、Node ≥18、零 npm 依赖（与 V1 一致）。
- Bash：`bin/wl` 用 `#!/usr/bin/env bash` + `set -euo pipefail`；hooks 用 `#!/bin/sh`，
  任何失败静默（exit 0），绝不阻塞用户工作。
- 全部文件 LF 换行（.gitattributes 已强制）。

## 文件所有权（每个模块只改自己名下的文件）

| 文件 | 所有者 |
| --- | --- |
| `bin/wl`, `hooks/post-commit`, `hooks/remind.sh`, `hooks/remind-daily.sh`, `hooks/hooks.codex.json`, `scripts/worklog/lib/paths.js`, `scripts/worklog/lib/util.js`, 根 `package.json`（type:module 已声明，覆盖 tests 与 lib） | 主线（已写好，其他模块只读） |
| `scripts/worklog/lib/collectors/codex.js`, `scripts/worklog/lib/collectors/gitlog.js` | collectors 模块 |
| `scripts/worklog/bin/worklog.js`, `scripts/worklog/lib/assemble.js` | assemble 模块 |
| `scripts/worklog/lib/commit.js` | commit 模块 |
| `scripts/worklog/lib/render.js` | render 模块 |
| `scripts/worklog/lib/match.js`, `scripts/worklog/schemas/match.schema.json` | match 模块 |
| `scripts/install.sh`, `agents-md/global-line.md` | installer 模块 |
| `skills/power-work-report/SKILL.md`, `README.md` | docs 模块 |
| `tests/hotpath.test.sh` | hotpath 测试模块 |
| `tests/coldpath/*.test.js`, `tests/coldpath/fixtures/**` | coldpath 测试模块 |

## 主线模块导出（已冻结，直接 import 使用）

### `scripts/worklog/lib/paths.js`

```js
resolveWlHome(explicit?)            // → WL_HOME 环境变量 || ~/.worklog（绝对路径）
resolveCodexHome(explicit?)         // → CODEX_HOME || ~/.codex（V1 原样）
wlPaths(wlHome?)                    // → 路径对象，见下
resolveTimezone(explicit?)          // V1 原样
assertValidDate(date)               // V1 原样（YYYY-MM-DD + 真实日历日，路径穿越在此封死）
dateWindow({codexHome, date, lookbackDays, timezone})   // V1 原样
localDateForTimestamp(timestamp, timezone)              // V1 原样
sessionDirForDate(codexHome, date)                      // V1 原样
localDayUtcRange(date, timezone)    // → { startIso, endIso }：目标本地日的 UTC 绝对时间边界
                                    //   （gitlog 采集器用于 git log --since/--until）
```

`wlPaths(wlHome)` 返回：

```js
{
  home,                    // wlHome 绝对路径
  inbox,                   // <home>/inbox.jsonl
  ledgerDir,               // <home>/ledger
  ledgerLog,               // <home>/ledger/ledger-log.jsonl
  ledgerSnapshot,          // <home>/ledger/ledger.json
  daysDir,                 // <home>/days
  stateDir,                // <home>/state
  reposList,               // <home>/state/repos.list
  dayDir(date),            // <home>/days/<date>
  dayJson(date),           // <home>/days/<date>/day.json
  confirmation(date),      // <home>/days/<date>/confirmation.json
  reportMd(date),          // <home>/days/<date>/report.md
  reportHtml(date),        // <home>/days/<date>/report.html
}
```

### `scripts/worklog/lib/util.js`

```js
normalizeText(value)             // trim + 空白折叠 + lowercase（V1 原样）
stableId(project, text)          // sha1 截 16 位（V1 原样，todo/idea 身份）
eventId(ts, text)                // sha1(ts + '\n' + text) 截 12 位（事件身份，实现方案 §4.1）
sha256Hex(text)
canonicalJson(value)             // 键排序后的稳定序列化（txId 用）
isoNow()                         // ISO-8601 本地带时区偏移
readJson(file, fallback)         // 失败/缺失返回 fallback
readRequiredJson(file)           // 失败抛错（带路径的报错信息）
readJsonl(file)                  // → 对象数组；坏行计数返回 { rows, badLines }
appendJsonLine(file, obj)        // 单行追加（mkdir -p 父目录）
atomicWrite(file, content)       // tmp + fsync + rename（实现方案 §5.3）
redactText(text)                 // 模式化脱敏（FR-12）：常见密钥/token/邮箱模式替换为 [REDACTED]
unique(values)                   // V1 原样
```

## 冷路径各模块必须实现的导出

### collectors（两个文件各自导出一个函数）

```js
// codex.js —— V1 collector.js 迁移，输出改为 FR-2 候选事件
collectCodex({ date, codexHome, timezone, lookbackDays })
  → { candidates, scan }
// gitlog.js
collectGitlog({ date, timezone, reposListPath, knownCommitSources })
  → { candidates, scan }
// knownCommitSources: Set<string>，形如 'commit:a3f2c19'（inbox 已有，输出差集）
```

候选事件形状（两个 collector 一致）：

```js
{ id,            // eventId(ts, text)
  ts,            // 事件时间戳 ISO-8601
  type,          // done | todo | idea
  text,          // 已经过 redactText
  project,       // 仓库名或 cwd 尾段
  source }       // 'archaeology:codex:<sessionId>' | 'archaeology:gitlog:<短sha>'
```

`scan` 对象自由形状，但必须可 JSON 序列化并计入 day.json 的 `scan.collectors.<name>`。
采集器内部失败（目录缺失等）静默跳过并记入 scan，不抛错。

### assemble 模块

```js
// assemble.js
assembleDay({ wlHome, date, timezone, lookbackDays, useLlm })
  → { path, day }        // 写 days/<date>/day.json 并返回
confirmDay({ wlHome, date, patch })   // patch 为对象；校验后写 confirmation.json
  → { path }
```

- day.json / confirmation.json 形状严格按实现方案 §4.2 / §4.3。
- 去重：先 sha 精确（source 'commit:*' 与 inbox 重合的候选丢弃）、再 normalizeText 精确；
  剩余交给 match（useLlm 且配置了模型时）。
- openTodosSnapshot 从 ledger.json 快照读（缺失视为空账本）。
- completionCandidates：normalizeText 完全相等 → by:'exact'；match 结果 → by:'llm'。
- overview：match 成功用其 overview，否则模板句 `共 N 条记录覆盖 M 个项目。`
- confirmDay 校验：未知 id 拒绝（报错列出未知 id）；缺省字段补空数组。

### commit 模块

```js
// commit.js
commitDay({ wlHome, date })  → { txId, noop }     // 实现方案 §5.3 原样语义
rebuildLedger({ wlHome })    → { days, todos }    // 重放 ledger-log 重建快照
```

- 唯一写 ledger 的组件。事务、幂等、崩溃语义、skipped 补记、supplement 流严格按实现方案。
- 快照形状按实现方案 §4.4。
- commit 成功后调用 render 模块的 `renderDay({ wlHome, date })` 刷新视图。

### render 模块

```js
// render.js
renderDay({ wlHome, date, html = false })   → { paths }   // report.md（+可选 html）
renderAll({ wlHome, html = false })         → { count }   // 全量重渲染（AC-12）
renderPeriod({ wlHome, start, end })        → { markdown } // 周/月视图（同一渲染器不同切片）
```

- report.md 结构严格按设计规格 FR-11（标题行/概览/完成/待办三段/想法/脚注），
  出处标记：`commit:*`→短 sha、`session:*`→⌥、`manual`→✎、`archaeology:*`→⌂。
- 渲染只读 ledger.json + day.json，绝不写它们（AC-12：重渲染后二者字节不变）。
- html 复用 V1 render.js 的 escapeHtml 与 HTML 骨架，删除 routeSteps 及全部退役流程词汇。

### match 模块

```js
// match.js
runMatch({ candidates, firsthand, openTodos, lang })
  → { merges, completions, overview }    // schema 见实现方案 §5.5；任何失败抛错
```

- 进程封装迁移 V1 codex-draft.js（runCodex/buildCodexArgs/extractFirstJsonObject 保值）。
- 模型：`WORKLOG_MATCH_MODEL` 必须存在才启用（无默认模型名）；bin：`WORKLOG_CODEX_BIN`（默认 codex）；
  effort：`WORKLOG_MATCH_REASONING_EFFORT` 白名单 minimal|low|medium|high|xhigh，非法即抛。
- 调用方（assemble）负责 catch：失败→merges/completions 空、overview 模板句（AC-9）。

### bin/worklog.js（冷路径入口）

- 子命令：`assemble | confirm | commit | render | rebuild | import-v1`。
- 每个子命令解析出 `--date` 后第一行执行 `assertValidDate`（rebuild/import-v1 无 date 除外）。
- 参数风格与 V1 cli.js 一致（--kebab-case，未知参数报错）。
- stdout 输出一行结果 JSON；错误走 stderr + exitCode 1（V1 bin 的包装方式）。
- `confirm --date D --patch <file|->`：`-` 表示从 stdin 读补丁。

## 测试约定

- 热路径测试：纯 sh 断言脚本，`WL_HOME=$(mktemp -d)` 沙箱，在 WSL 执行。
- 冷路径测试：`node --test tests/coldpath/`，V1 时区用例从
  `D:\Code\ohmypowers\tests\power-work-report\cli.test.js` 迁移语义（fixtures 自建）。
- mock codex：沿用 V1 思路（tests/coldpath/fixtures/bin/ 下放 mock 可执行）。
- 验收标准 AC-1…AC-14 见设计规格；AC-4/AC-13 是对话行为，不进自动化。
