# worklog

**在发生时把这一天记下来;日志考古只是兜底。**

事件捕获式个人日报系统:git 提交、口头一句话、agent 交付在发生的那一刻就落进收件箱,第二天用不到一分钟的确认,换一份一屏日报和持续维护的待办/想法账本。零 daemon、零数据库、零服务端,全部是本地人类可读文本;LLM 只是可拔插的判断层,不配置也全链路可用。

## 三层捕获链

1. **git 钩子(机械,主承重)**:全局 `core.hooksPath` 下的 `post-commit` 把每次非 merge 提交自动记为一条 done 事件(`wl done --source commit:<sha>`)。rebase/amend 产生的重复由装配器去重(commit 来源按"项目 + 归一化文本"),钩子只管傻写。
2. **口头触发词(半机械,唯一常驻指令)**:对 agent 说「记一下」→ note、「记个待办」→ todo、「记个想法」→ idea,agent 立即执行对应 `wl` 命令并继续当前任务。触发词固定,判断权在你——agent 不自行揣测某句话"像不像想法"。
3. **agent 交付 tee(尽力而为)**:power-gan 交付收尾报告的同时顺手 `wl done --source session:<id>`。

三层互为冗余;都漏掉的,还有采集器考古(Codex 会话 + git log)在确认面以候选形式捞回——候选永不直接入账,经你点头才写进账本。

## 安装

```bash
bash scripts/install.sh
```

安装器幂等,它会动这些东西(每步有提示):

1. 建 `~/.worklog/{ledger,days,state}`,把 `bin/ hooks/ scripts/` 复制到 `~/.worklog` 下(hook 配置指向副本,与克隆目录解耦),`chmod +x`。
2. 软链 `~/.local/bin/wl`(不在 PATH 时给出提示)。
3. **`git config --global core.hooksPath`**:未设置 → 指向 `~/.worklog/git-hooks`,并打印遮蔽警告——全局 hooksPath 会遮蔽各仓库 `.git/hooks/`,因此 `post-commit` 内建链式回调,`.git/hooks/` 式的本地钩子仍会被执行;已设置为其他值 → **不覆盖**,打印在你既有钩子目录里追加两行调用的说明。**注意**:设置了仓库本地 `core.hooksPath` 的仓库(husky v5+ 标准安装即如此)会覆盖全局配置,worklog 钩子在这类仓库不会运行——需要在其钩子目录的 `post-commit` 末尾手工追加一行 `"$HOME/.worklog/git-hooks/post-commit" "$@" || true`,否则该仓库既无捕获也不入 gitlog 考古兜底。
4. **`~/.codex/hooks.json`**:不存在 → 写入提醒 hook 片段(SessionStart + UserPromptSubmit,见 `hooks/hooks.codex.json`);已存在 → 先备份,再 jq 深合并(同事件数组追加,不删既有项)。Codex 首次会请求信任非托管 hook;可用 `codex features list` 确认 hooks 开关。
5. 打印全局 AGENTS.md 需要的那一行(口头触发词指令,见 `agents-md/global-line.md`),由你自行粘贴——安装器不改你的全局指令文件。
6. 自校验:执行一条 `wl note --project install-check -- "installed"` 并展示 inbox 尾行。

## 日常使用

### 捕获(任何仓库、任何目录可用)

```bash
wl done -- "修复授权衰减边界判定"          # project 缺省取当前 git 仓库名
wl todo --project worklog -- "补 macOS flock 降级测试"
wl idea -- "周报做成同一渲染器的时间切片"
wl note --redact -- "调试 webhook 时踩到 401 …"   # --redact:落盘前模式化脱敏
```

git commit 之后什么都不用做——`post-commit` 钩子已经自动记了一条。

### 查欠账

```bash
wl status
# worklog:2026-07-25 未确认,最近一日 9 条
```

### D+1 确认(默认节奏)

第二天开工,会话里出现一行 `[worklog] 2026-07-25 有未确认记录(最近一日 9 条)…`。回一句「对一下昨天」(或 `$power-work-report`),agent 会:

1. `wl assemble --date 2026-07-25` 装配当日草稿;
2. 一屏呈现:一手记录仅展示不逐条询问;捞漏候选与完成候选编号 ①②③ 请你点头;账龄一句;
3. 你一句话确认——「①和③算,②不要,④确实完成了,再记个想法 X」;
4. agent 把口头补丁翻译成 confirmation 落盘,复述一行摘要,你点头后 `wl commit` → 一行回执,`report.md` 生成。

不想弄:「待会儿」或不回应即零成本退出,当日不再提;「跳过今天」记 skipped,不再纠缠。当天想立刻结算:说「收工」。

## 数据布局(`~/.worklog`)

三个区、三种承诺:

| 区 | 文件 | 承诺 |
| --- | --- | --- |
| inbox | `inbox.jsonl` | WAL:**只追加,永不改写**,任何组件不得改写或删除其中的行 |
| ledger | `ledger/ledger-log.jsonl` + `ledger/ledger.json` | **唯一资产**:事务日志只追加,快照临时文件写完 rename 原子替换;快照损坏由 `wl rebuild` 重放事务日志完整重建 |
| days | `days/<date>/{day.json,confirmation.json,report.md,report.html}` | **可再生缓存**:任何文件可由 ledger 与 inbox 重新装配/渲染 |

改了日报模板后 `wl render --all` 全量重渲染历史,day.json 与 ledger 一字节不变。整个 `~/.worklog` 是 UTF-8 人类可读文本,可自行 `git init` 成私有仓库获得历史、备份与同步——系统不内置同步。

## 配置

| 配置 | 作用 | 默认 |
| --- | --- | --- |
| `WL_HOME` | 根目录 | `~/.worklog` |
| `WORKLOG_MATCH_MODEL` | LLM 匹配层模型;**不设置则匹配层关闭**,候选原样展示、概览用模板句 | 无(必须显式设置才启用) |
| `WORKLOG_CODEX_BIN` | 匹配层调用的 codex 可执行 | `codex` |
| `WORKLOG_MATCH_REASONING_EFFORT` | 推理档位,白名单 `minimal\|low\|medium\|high\|xhigh` | `medium` |
| `WORKLOG_MATCH_TIMEOUT_MS` | 匹配层子进程超时(毫秒),超时即降级 | `120000` |
| `git config worklog.capture false` | **per-repo 关闭**:commit 捕获与 gitlog 考古兜底都跳过该仓库 | 开启 |

## 逃生门

全部零罪恶感设计——不会出现「你已连续 N 天未记录」类文案:

- **跳过今天**:确认对话里回一句「跳过今天」,该日记 skipped,不再提。
- **明天一起**:不回应即可;当日不再提醒,次日欠账合并为一行区间提示。
- **多日批量补账**:多天欠账时逐日最小摘要,摘要压缩更狠,不搞长审讯。
- **per-repo 关闭**:在仓库里 `git config worklog.capture false`,commit 捕获与 gitlog 考古兜底一并跳过。
- **提醒降级**(各为一行配置的切换):
  - 方案 B:从 `~/.codex/hooks.json` 删掉 `UserPromptSubmit` 段,仅保留 SessionStart 提醒。
  - 方案 C:删掉两段 hook 配置,提醒完全撤出 agent;把 `wl status` 挂到 shell 提示符(`PROMPT_COMMAND` / `precmd`)。

## 隐私

- inbox 以你手写的文本与 commit subject 为主,**不强制脱敏**;含敏感内容时用 `--redact` 事前脱敏——inbox 永不改写,落盘即定格,含密钥的 commit subject 会原样入 inbox。
- 采集器候选出口自动做模式化脱敏(常见密钥、token、邮箱模式),发生在候选进入确认面之前。
- 报告分享前请自查:report.md 可能含项目名、路径与提交主题。

## macOS 注意

- `flock` 非 macOS 自带:缺失时 `wl` 自动降级为纯 O_APPEND 追加(单行写近似原子,日常够用);介意可 `brew install flock`。
- 脚本已避开 GNU 专属用法(不用 `date -I` 等),BSD date 可用。

## 测试

在 WSL / Linux 下运行:

```bash
bash tests/hotpath.test.sh     # 热路径:纯 sh 断言,临时 WL_HOME 沙箱
node --test tests/coldpath/    # 冷路径:node --test,含 V1 迁移的时区用例
```

Windows 下经 WSL:

```bash
wsl -d Ubuntu -e bash -c 'cd /mnt/d/Code/worklog && bash tests/hotpath.test.sh'
wsl -d Ubuntu -e bash -c 'cd /mnt/d/Code/worklog && node --test tests/coldpath/'
```
