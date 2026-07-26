# worklog 实现方案

日期:2026-07-26
依据:`2026-07-26-worklog-event-capture-daily-report-spec.md`(下称"设计规格")
状态:实现定稿,按阶段 M0–M4 交付

命名占位:根目录 `~/.worklog`、命令 `wl`(设计规格待定决策 2)。全部代码经 `WL_HOME` 环境变量与安装器中的单一变量取名,改名成本为一处。

## 1. 仓库布局与交付物

独立仓库(或 ohmypowers 的姊妹仓库),布局沿用既有工程惯例:

```
worklog/
  bin/
    wl                        # bash 主入口(热路径 + 冷路径转发)
  hooks/
    post-commit               # 全局 git 钩子
    remind.sh                 # SessionStart hook
    remind-daily.sh           # UserPromptSubmit hook(日频快路径)
    hooks.codex.json          # 待合并进 ~/.codex/hooks.json 的片段
  scripts/worklog/            # 冷路径(Node ≥18,零 npm 依赖,延续 V1)
    bin/worklog.js
    lib/assemble.js
    lib/collectors/codex.js   # 由 V1 collector.js 迁移
    lib/collectors/gitlog.js
    lib/match.js              # LLM 匹配层(复用 V1 codex-draft 的进程封装)
    lib/commit.js             # 提交器
    lib/render.js             # report.md 模板;html 由 V1 render.js 适配
    lib/paths.js              # 由 V1 迁移(时区工程原样保值)
    schemas/match.schema.json
  skills/
    power-work-report/SKILL.md   # V2:确认对话驱动
  agents-md/global-line.md    # 全局 AGENTS.md 需要的那一行(原文)
  scripts/install.sh
  tests/
    hotpath.test.sh           # 纯 sh 断言
    coldpath/                 # node --test,含 V1 迁移来的时区用例
docs/specs/…                  # 设计规格与本文档
```

运行时目录(由 `wl` 首次运行创建):

```
$WL_HOME/
  inbox.jsonl
  ledger/ledger-log.jsonl
  ledger/ledger.json
  days/YYYY-MM-DD/{day.json,confirmation.json,report.md,report.html}
  state/remind-YYYY-MM-DD     # 日频标记
  state/repos.list            # 见过的 git 仓库路径(gitlog 采集器用)
  bin/ hooks/                 # 安装器复制的可执行副本(hook 配置指向这里,不指向克隆目录)
```

## 2. 阶段划分

每个阶段结束系统均可独立使用;后一阶段不返工前一阶段的接口。

| 阶段 | 内容 | 完成即满足的 AC |
| --- | --- | --- |
| M0 | `wl` 骨架 + 捕获四命令 + inbox 落盘 | AC-14(部分) |
| M1 | git 钩子、repos.list、AGENTS.md 一行、power-gan tee 补丁 | AC-1 |
| M2 | 结算最小闭环:assemble → 确认 → commit → render(md),零 LLM | AC-5/6/7/8/9/11/12 |
| M3 | remind 双 hook + 逃生门 | AC-2/3/4/13 |
| M4 | LLM 匹配层、html 与周/月视图、V1 数据迁移 | AC-10 + 迁移完成 |

M2 结束即可靠显式触发日常使用;M3 才引入任何 agent 链路挂点。

## 3. 热路径实现(bash)

### 3.1 `bin/wl` 主入口

```bash
#!/usr/bin/env bash
set -euo pipefail
WL_HOME="${WL_HOME:-$HOME/.worklog}"
INBOX="$WL_HOME/inbox.jsonl"
COLD="$WL_HOME/scripts/worklog/bin/worklog.js"

iso_now() {  # macOS BSD date 无 -Is;统一手工拼并补冒号
  date +%Y-%m-%dT%H:%M:%S%z | sed 's/\([0-9][0-9]\)$/:\1/'
}

capture() {
  local type="$1"; shift
  local project="" source="manual" text=""
  while [ $# -gt 0 ]; do case "$1" in
    --project) project="$2"; shift 2 ;;
    --source)  source="$2";  shift 2 ;;
    --redact)  REDACT=1;     shift   ;;
    --)        shift; text="$*"; break ;;
    *)         text="$1"; shift ;;
  esac; done
  [ -n "$text" ] || { echo "wl: text required" >&2; exit 2; }
  if [ -z "$project" ] && git rev-parse --show-toplevel >/dev/null 2>&1; then
    project="$(basename "$(git rev-parse --show-toplevel)")"
  fi
  mkdir -p "$WL_HOME"
  local line
  line="$(jq -cn --arg ts "$(iso_now)" --arg type "$type" --arg text "$text" \
                 --arg project "$project" --arg source "$source" \
                 '{ts:$ts,type:$type,text:$text,project:$project,source:$source}')"
  { flock 9; printf '%s\n' "$line" >&9; } 9>>"$INBOX"
}

case "${1:-help}" in
  done|todo|idea|note) t="$1"; shift; capture "$t" "$@" ;;
  status)  exec "$WL_HOME/hooks/remind.sh" --human ;;
  remind)  shift; exec "$WL_HOME/hooks/remind.sh" "$@" ;;
  assemble|confirm|commit|render|rebuild)
           exec node "$COLD" "$@" ;;          # 冷路径整体转发
  help|*)  echo "usage: wl done|todo|idea|note [--project P] [--source S] TEXT
       wl status | assemble | confirm | commit | render | rebuild" ;;
esac
```

实现要点:

- **转义与原子性**:JSON 只由 `jq -n --arg` 生成(设计规格 FR-2);追加经 `flock` 串行化——单行写本已近似原子,flock 把"近似"变成保证,成本一次 fcntl。
- **冷路径转发**:`assemble` 及之后的子命令 exec 给 Node,`wl` 自身不含任何重逻辑;`case` 分发保证热命令路径上无 Node 进程(AC-14)。
- 退出码约定:0 成功;2 用法错误;捕获路径的任何失败不重试、不排队——commit 钩子和 tee 调用方均以 `|| true` 吞掉,绝不阻塞用户主工作(NFR 故障模型)。

### 3.2 全局 git 钩子 `hooks/post-commit`

```bash
#!/usr/bin/env bash
WL_HOME="${WL_HOME:-$HOME/.worklog}"

# 全局 core.hooksPath 会遮蔽仓库本地钩子(husky 等),必须链式回调:
local_hook="$(git rev-parse --git-path hooks/post-commit 2>/dev/null)"
[ -x "$local_hook" ] && "$local_hook" "$@" || true

# merge commit 跳过(父提交数 > 1)
[ "$(git rev-list --parents -n1 HEAD | wc -w)" -gt 2 ] && exit 0

sha="$(git rev-parse --short HEAD)"
subject="$(git log -1 --format=%s)"
top="$(git rev-parse --show-toplevel)"
repo="$(basename "$top")"

# 登记仓库路径,供 gitlog 采集器使用
grep -qxF "$top" "$WL_HOME/state/repos.list" 2>/dev/null \
  || { mkdir -p "$WL_HOME/state"; printf '%s\n' "$top" >> "$WL_HOME/state/repos.list"; }

"$WL_HOME/bin/wl" done --project "$repo" --source "commit:$sha" -- "$subject" \
  2>/dev/null || true
```

链式回调是关键细节:`core.hooksPath` 一经全局设置,所有仓库的 `.git/hooks/*` 都失效——不补这一段会静默弄坏用户已有的 husky/lint 钩子。rebase/amend 造成的重复提交在此不处理,由装配器按 sha 去重(钩子只管傻写)。

### 3.3 提醒 `hooks/remind-daily.sh`(UserPromptSubmit)

```bash
#!/bin/sh
WL_HOME="${WL_HOME:-$HOME/.worklog}"
today="$(date +%F)"
m="$WL_HOME/state/remind-$today"
[ -e "$m" ] && exit 0                         # 快路径:一次 stat
mkdir -p "$WL_HOME/state"; : > "$m"
find "$WL_HOME/state" -name 'remind-*' -mtime +7 -delete 2>/dev/null
exec "$WL_HOME/hooks/remind.sh"
```

### 3.4 提醒 `hooks/remind.sh`(SessionStart / 真实检查)

```bash
#!/bin/sh
WL_HOME="${WL_HOME:-$HOME/.worklog}"
LEDGER="$WL_HOME/ledger/ledger.json"
today="$(date +%F)"

confirmed="$(jq -r '.confirmedThrough // "1970-01-01"' "$LEDGER" 2>/dev/null \
             || echo 1970-01-01)"

# 有数据的日期 = inbox 中出现过的日期(升序去重),过滤 (confirmed, today)
days="$(cut -c9-18 "$WL_HOME/inbox.jsonl" 2>/dev/null | sort -u \
        | awk -v a="$confirmed" -v b="$today" '$0 > a && $0 < b')"
[ -n "$days" ] || exit 0                      # 无欠账:零输出零注入(AC-2)

n="$(printf '%s\n' "$days" | wc -l | tr -d ' ')"
first="$(printf '%s\n' "$days" | head -1)"; last="$(printf '%s\n' "$days" | tail -1)"
if [ "$n" -eq 1 ]; then span="$first"; else span="$first – $last($n 天)"; fi
count="$(grep -c "\"ts\":\"$last" "$WL_HOME/inbox.jsonl" 2>/dev/null || echo 0)"

if [ "${1:-}" = "--human" ]; then
  printf 'worklog:%s 未确认,最近一日 %s 条\n' "$span" "$count"; exit 0
fi
printf '[worklog] %s 有未确认记录(最近一日 %s 条)。仅在答完用户当前请求后用一句话附带提及;用户未回应则今日不再提。与当前任务无关时勿展开。\n' "$span" "$count"
```

实现注解:

- `cut -c9-18` 依赖 FR-2 固定行首 `{"ts":"YYYY-MM-DD…`——jq 键序稳定,契约成立;测试锁住该假设。
- 只以 inbox 判定"有数据",不做日期算术(BSD/GNU `date -d` 差异整个绕开)。纯考古日(inbox 空但 codex 有会话)提醒不到,由显式触发与下次结算覆盖——设计规格 FR-10 的窄缝,记录为已知取舍。
- 无数据日的 skipped 标记不在这里写(热路径不碰 ledger),由下次提交器结算时补记。
- 任何失败(ledger 缺失、inbox 缺失)走 `|| echo` 默认值或直接 exit 0——故障静默。

### 3.5 Codex hooks 配置片段 `hooks/hooks.codex.json`

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "startup|resume|clear",
        "hooks": [ { "type": "command",
                     "command": "$HOME/.worklog/hooks/remind.sh", "timeout": 5 } ] } ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
                     "command": "$HOME/.worklog/hooks/remind-daily.sh", "timeout": 5 } ] } ]
  }
}
```

不设 `statusMessage`;不挂 PreToolUse/PostToolUse(设计规格红线)。安装器负责与用户既有 `~/.codex/hooks.json` 的 jq 合并,不整体覆盖。

## 4. 数据契约

### 4.1 inbox 事件行(FR-2,重列供实现对照)

`{"ts","type","text","project","source"}`,键序固定如此。装配时赋予事件 id:`sha1(ts + "\n" + text)` 截 12 位——inbox 本身不存 id,保证行格式最简。

### 4.2 `day.json`(装配产物,确认面的数据源)

```json
{
  "schemaVersion": 1, "date": "2026-07-25", "assembledAt": "…",
  "firsthand":  [ { "id": "e1a2…", "ts": "…", "type": "done", "text": "…",
                    "project": "…", "source": "commit:a3f2c19" } ],
  "candidates": [ { "id": "c9f0…", "type": "done", "text": "…", "project": "…",
                    "source": "archaeology:codex:session-a" } ],
  "completionCandidates": [ { "todoId": "t3b4…", "evidence": "commit:a3f2c19",
                              "confidence": "high", "by": "llm|exact" } ],
  "openTodosSnapshot": [ { "id": "t3b4…", "text": "…", "project": "…",
                           "ageDays": 4 } ],
  "overview": { "text": "…", "by": "llm|template" },
  "scan": { "inboxLines": 8, "collectors": { "codex": {…}, "gitlog": {…} } }
}
```

### 4.3 `confirmation.json`(唯一可编辑物,FR-8)

```json
{
  "date": "2026-07-25",
  "acceptCandidates": ["c9f0…"],
  "rejectCandidates": ["c7d1…"],
  "editText":  [ { "id": "e1a2…", "text": "改后的文案" } ],
  "completeTodos": [ { "todoId": "t3b4…", "evidence": "commit:a3f2c19" } ],
  "addTodos": [ { "text": "…", "project": "…" } ],
  "addIdeas": [ { "text": "…" } ],
  "skipDay": false
}
```

确认面向用户展示编号(①②③…),agent 维护"编号 → id"映射并翻译口头补丁;缺省字段视为空数组。未列出的候选一律不入账(AC-11)。

### 4.4 `ledger-log.jsonl` 事务与 `ledger.json` 快照

```json
{"txId":"2026-07-25:9d41…","date":"2026-07-25","appliedAt":"…",
 "confirmation":{…原文…},"resolvedEvents":[…入账事件终态…]}
```

- `txId = date + ":" + sha256(canonical(confirmation))`(键排序后序列化再哈希)。
- 快照:

```json
{ "schemaVersion": 1, "confirmedThrough": "2026-07-25",
  "todos": [ { "id","text","project","status":"open|done|dropped",
               "createdDate","updatedAt","closedDate?","sources":[…] } ],
  "ideas": [ … ],
  "days":  { "2026-07-25": { "status":"confirmed|skipped|supplemented",
                             "txId":"…","counts":{"done":4,"todoAdd":1} } } }
```

- `rebuild` = 空状态起按 log 顺序重放全部事务;快照与 log 冲突以 log 为准(AC-8)。
- `confirmedThrough` 单调不减;跳日(skipDay)同样产生事务,保证提醒判定收敛。

## 5. 冷路径实现(Node,`scripts/worklog/`)

### 5.1 V1 复用映射

| V1 | 去向 | 改动 |
| --- | --- | --- |
| lib/paths.js | lib/paths.js | 原样迁移(dateWindow、localDateForTimestamp、carry 逻辑与其测试) |
| lib/collector.js | lib/collectors/codex.js | 输出改为 FR-2 候选事件形状;todo/idea 关键词启发式保留但仅产候选 |
| lib/codex-draft.js | lib/match.js | 保留 runCodex/buildCodexArgs/extractFirstJsonObject;prompt 与 schema 换为匹配任务;删 routeSteps |
| lib/render.js | lib/render.js + html 适配 | escapeHtml 与 HTML 骨架保值;数据源改 day.json+ledger;删 routeSteps |
| lib/memory.js | 提交器内联 | normalizeText/itemKey/stableId 保留 |
| lib/finalize.js | lib/commit.js | 重写:事务模型 + 原子写(V1 必修缺陷 2 在此消除) |
| lib/cli.js | bin/worklog.js | 重写:入口即 `assertValidDate`(V1 必修缺陷 1 在此消除) |

### 5.2 `bin/worklog.js` 子命令契约

- `assemble --date D [--timezone TZ] [--lookback N]`:读 inbox 当日行 + 跑采集器 → 确定性去重(sha 精确、归一化文本精确)→ 可选调 match.js → 写 `days/D/day.json`。stdout 输出路径 JSON。
- `confirm --date D --patch <file|->`:校验 confirmation 结构与 id 存在性后落盘 `days/D/confirmation.json`(仅校验与写入,不动 ledger)。
- `commit --date D`:提交器,见 5.3。
- `render --date D | --range M | --all [--html]`:由 ledger + day.json 渲染视图。
- `rebuild`:重放 ledger-log。
- 所有子命令第一行执行 `assertValidDate`(路径穿越在入口封死)。

### 5.3 提交器 `lib/commit.js`

```js
export async function commitDay({ paths, date }) {
  const confirmation = await readRequiredJson(paths.confirmation(date))
  const txId = `${date}:${sha256(canonicalJson(confirmation))}`
  const log = await readLog(paths.ledgerLog)
  if (log.some(tx => tx.txId === txId)) return { txId, noop: true }   // AC-7

  const day = await readRequiredJson(paths.day(date))
  const resolved = resolve(day, confirmation)        // 纯函数:草稿+补丁→入账终态
  const state = replay(log).apply({ txId, date, confirmation, resolved })

  await appendLine(paths.ledgerLog, { txId, date, appliedAt: iso(), confirmation, resolved })
  await atomicWrite(paths.ledgerSnapshot, render(state))   // tmp + fsync + rename
  await renderViews({ paths, date, state })
  return { txId, noop: false }
}
```

- `atomicWrite`:写 `target.tmp-<pid>` → `fh.sync()` → `rename`。
- 先追加 log 后换快照:崩在两步之间 = 快照落后于 log,`rebuild` 语义天然修复;绝无半事务(NFR 故障模型)。
- 已确认日的补充事件(AC-10):assemble 发现 `days[date].status==="confirmed"` 且当日 inbox 出现晚于 `appliedAt` 的行时,产出 `mode:"supplement"` 草稿,提交后该日 status 置 `supplemented`,原事务不动。
- 无数据欠账日:commit 沿途将 (confirmedThrough, date) 间无数据的日子批量补记 `skipped` 事务,提醒判定由此收敛。

### 5.4 gitlog 采集器 `lib/collectors/gitlog.js`

读 `state/repos.list`,对每个仓库 `git log --since/--until`(目标本地日边界经 paths.js 的时区映射换算为绝对时间),`--format=%h%x1f%s%x1e` 解析,产出候选;与 inbox 按 `commit:<sha>` 精确去重后仅输出差集(钩子漏网:钩子未装期间、merge 被跳过但确有意义等)。仓库目录不存在则静默跳过并计入 scan。

### 5.5 LLM 匹配层 `lib/match.js`

- 进程封装沿用 V1(`codex exec --json --ephemeral --sandbox read-only --output-schema match.schema.json`,prompt 走 stdin,临时目录,失败即抛)。
- 输入:`{candidates, firsthand, openTodos}`(仅文本与 id,不传全量上下文);输出 schema:

```json
{ "merges":   [ { "candidateId": "…", "duplicateOf": "…" } ],
  "completions": [ { "candidateId": "…", "todoId": "…", "confidence": "high|low" } ],
  "overview": "两三句" }
```

- `reasoningEffort` 白名单校验(minimal|low|medium|high|xhigh),模型经 `WORKLOG_MATCH_MODEL` 注入,代码无默认模型名硬编码文档化(V1 必修缺陷 4 类问题不再复现);`child.stdin` 挂 error 处理(V1 次要缺陷修复随迁移带入)。
- 任何失败:merges/completions 置空、overview 走模板句,assemble 正常完成(AC-9)。

### 5.6 report.md 渲染

模板即设计规格 FR-11 的样例形状,实现约束:出处标记映射 `commit:*→短sha`、`session:*→⌥`、`manual→✎`;"保留"段账龄取 `today - createdDate` 最大值;概览缺省模板句 `共 N 条记录覆盖 M 个项目。`;全文不含表格与 HTML。html 渲染为可选路径,复用 V1 组件骨架。

## 6. Agent 面

### 6.1 全局 AGENTS.md(唯一常驻一行,原文)

```
用户以「记一下 / 记个待办 / 记个想法」开头或明确要求记录时,立即执行
`wl note|todo|idea "<内容>"`(类型按用户措辞),然后继续当前任务,不展开讨论。
```

### 6.2 power-gan 交付 tee(SKILL.md Delivery 段追加一句)

```
交付报告 outcome 的同时,执行 `wl done --source "session:<会话标识>" -- "<outcome 一句话>"`;
该命令失败不影响交付报告。
```

### 6.3 power-work-report SKILL.md V2 骨架

- 触发:用户显式请求、`$power-work-report`、或注意到 hook 注入的 `[worklog]` 欠账提示且用户同意。
- 流程:`wl assemble --date D` → 读 day.json → 按一分钟形状呈现(一手仅展示;编号呈现捞漏与完成候选;账龄一句)→ 将口头补丁翻译为 confirmation.json 并 `wl confirm --patch -` → 复述一行待入账摘要 → 用户点头后 `wl commit --date D` → 一行回执。
- 边界:day.json 与 report 是生成物禁止直接编辑;confirmation 未确认不 commit;"待会儿/跳过今天"零成本退出("跳过"= `{"skipDay":true}` 的 confirmation);多日欠账逐日最小摘要,禁止长审讯;不主动生成当日报告除非用户处于收工模式。

## 7. 安装器 `scripts/install.sh`

幂等步骤:

1. `mkdir -p $WL_HOME/{ledger,days,state}`;复制 `bin/ hooks/ scripts/` 到 `$WL_HOME` 对应位置(hook 配置引用 `$WL_HOME` 下副本,与克隆目录解耦);`chmod +x`。
2. `~/.local/bin/wl` 软链(PATH 提示)。
3. git 钩子:`git config --global core.hooksPath` 未设置 → 设为 `$WL_HOME/git-hooks` 并打印遮蔽警告与链式回调说明;已设置为其他值 → 不覆盖,打印在既有钩子目录内追加调用的两行说明。
4. Codex hooks:`~/.codex/hooks.json` 不存在 → 写入片段;存在 → `jq -s` 深合并(同事件数组追加,不删既有项),合并前备份原文件;打印"Codex 将请求信任非托管 hook"与 `codex features list` 检查 hooks 开关的提示。
5. 打印 AGENTS.md 那一行,请用户自行粘贴(不自动改用户的全局指令文件)。
6. 校验:跑一次 `wl note --project install-check -- "installed"` 并展示 inbox 尾行,随后提示可删除。

## 8. 测试计划

热路径 `tests/hotpath.test.sh`(临时 WL_HOME 沙箱):

- 捕获:四命令落行、jq 转义(文本含引号/换行/中文)、flock 并发 50 进程无交错(AC-1 基础)。
- 行首契约:`cut -c9-18` 能取出日期(锁 FR-2 键序)。
- remind:无欠账零输出(AC-2);单日/多日区间文案;标记文件二次调用 exit 0 且零输出(AC-3 的本地等价);ledger 缺失静默。
- post-commit:临时仓库 commit → inbox 出现对应行;merge 跳过;本地钩子链式回调被执行;repos.list 去重登记。

冷路径 `tests/coldpath/`(node --test):

- V1 迁移用例原样保值:跨日切片、UTC 目录进位、重跑排除。
- assemble:sha 去重、候选不含 inbox 已有 commit、day.json 形状。
- confirm/commit:补丁校验拒绝未知 id;txId 幂等(AC-7);崩溃注入(log 已写、快照未换)后 rebuild 一致(AC-8);未点头候选不入账(AC-11);supplement 流(AC-10);skipDay 与无数据日补记。
- match:mock codex 成功/失败/坏 JSON → 降级路径(AC-9);effort 白名单拒绝。
- render:模板改动 + `--all` 重渲染,ledger 与 day.json 字节不变(AC-12)。
- 入口:非法 `--date`(含 `../`)全子命令拒绝。

AC-4/AC-13 属对话行为,不进自动化;在 SKILL.md 边界中固化并人工验收。

## 9. V1 迁移步骤(M4)

1. `node scripts/worklog/bin/worklog.js import-v1 --memory ~/.codex/daily-reports/memory.json`:todos/ideas 归一化导入为一笔 `import` 事务;`confirmedThrough` 置为 memory 中最后 report 日期。
2. 历史 daily-reports 目录原地保留只读,不转换(旧报告是旧系统的产物)。
3. ohmypowers 侧:power-work-report V1 技能标记退役,installer 的 retired 列表加入;V2 技能与 tee 补丁随本仓库安装。

## 10. 已知风险与实现注意

- **core.hooksPath 遮蔽**是本方案侵入性最高的一步,链式回调 + 安装器不覆盖既有配置是两道保险;文档需醒目说明。
- Codex hooks 需 feature 开启且非托管 hook 首次要求信任;安装器只提示、不代按。
- macOS 便携性:`date -I` 不用;`sed`/`find -mtime`/`flock` 需在 macOS 验证(`flock` 非 macOS 自带——降级方案:macOS 上省略 flock,依赖 O_APPEND 单行原子性,测试相应放宽;或文档建议 `brew install flock`)。
- inbox 永不改写意味着脱敏(FR-12)只对候选与展示层生效;含密钥的 commit subject 会原样入 inbox——文档明示,`--redact` 提供事前手段。
- 提醒窄缝(纯考古日不提醒)与多日区间文案的取舍已在 3.4 注解记录。
- 待定决策 1(默认结算节奏)只影响 remind 文案与 SKILL.md 触发描述,不影响任何数据契约;可最后拍板。
