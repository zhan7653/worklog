#!/usr/bin/env bash
# worklog 热路径测试(实现方案 §8)。纯 bash 断言,不依赖任何测试框架。
# 运行(WSL/Linux):bash tests/hotpath.test.sh
# 约定:每个用例独立 WL_HOME="$(mktemp -d)" 沙箱;结束时非零退出码表示存在失败。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WL_BIN="$REPO_ROOT/bin/wl"
HOOKS_DIR="$REPO_ROOT/hooks"

PASS=0
FAIL=0
SANDBOXES=()

cleanup() {
  local d
  for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

new_sandbox() { # 结果放入全局 SB(命令替换在子 shell 里,数组追加会丢,故不经 stdout 返回)
  SB="$(mktemp -d)"
  SANDBOXES+=("$SB")
}

pass() { PASS=$((PASS + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1" >&2; }

assert_eq() { # $1=描述 $2=期望 $3=实际
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — 期望 [$2] 实际 [$3]"; fi
}

assert_contains() { # $1=描述 $2=全文 $3=子串
  case "$2" in
    *"$3"*) pass "$1" ;;
    *) fail "$1 — 输出 [$2] 不含 [$3]" ;;
  esac
}

count_lines() { wc -l <"$1" | tr -d '[:space:]'; }

# ---------- JSON 工具:python3 优先(CONTRACTS:WSL 里 jq 可能不存在),jq 兜底 ----------

JSON_TOOL=''
if command -v python3 >/dev/null 2>&1; then
  JSON_TOOL='python3'
elif command -v jq >/dev/null 2>&1; then
  JSON_TOOL='jq'
else
  echo 'hotpath.test.sh: 需要 python3 或 jq 之一' >&2
  exit 1
fi

json_ok() { # $1=单行 JSON;合法返回 0
  if [ "$JSON_TOOL" = python3 ]; then
    printf '%s' "$1" | python3 -c 'import json,sys; json.loads(sys.stdin.buffer.read().decode("utf-8"))' >/dev/null 2>&1
  else
    printf '%s' "$1" | jq -e . >/dev/null 2>&1
  fi
}

json_field() { # $1=单行 JSON $2=键;值写 stdout(经 buffer 读写绕开 locale,UTF-8 字节级往返)
  if [ "$JSON_TOOL" = python3 ]; then
    printf '%s' "$1" | WL_KEY="$2" python3 -c '
import json, os, sys
obj = json.loads(sys.stdin.buffer.read().decode("utf-8"))
sys.stdout.buffer.write(str(obj[os.environ["WL_KEY"]]).encode("utf-8"))'
  else
    printf '%s' "$1" | jq -r --arg k "$2" '.[$k]'
  fi
}

rel_date() { # $1 天前的本地日期 YYYY-MM-DD(测试仅跑 WSL/Linux,GNU date;python3 兜底)
  date -d "-$1 day" +%F 2>/dev/null \
    || python3 -c 'import datetime,sys; print((datetime.date.today()-datetime.timedelta(days=int(sys.argv[1]))).isoformat())' "$1"
}

inbox_line() { # $1=日期 $2=type $3=纯 ASCII text $4=inbox 路径;手工拼 FR-2 固定键序行
  printf '{"ts":"%sT10:00:00+08:00","type":"%s","text":"%s","project":"tp","source":"manual"}\n' \
    "$1" "$2" "$3" >>"$4"
}

# ---------- 1. 捕获四命令:各落一行且 type 正确 ----------

test_capture_types() {
  new_sandbox; local home="$SB"
  new_sandbox; local cwd="$SB" # 非 git 目录,避免 project 推断干扰
  local inbox="$home/inbox.jsonl"
  local t i line rc
  for t in done todo idea note; do
    (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" "$t" "text-$t"); rc=$?
    assert_eq "capture: wl $t 退出码 0" 0 "$rc"
  done
  assert_eq 'capture: 四命令各落一行' 4 "$(count_lines "$inbox")"
  i=1
  for t in done todo idea note; do
    line="$(sed -n "${i}p" "$inbox")"
    json_ok "$line"; assert_eq "capture: 第 $i 行是合法 JSON" 0 $?
    assert_eq "capture: 第 $i 行 type=$t" "$t" "$(json_field "$line" type)"
    assert_eq "capture: 第 $i 行 text 往返一致" "text-$t" "$(json_field "$line" text)"
    i=$((i + 1))
  done
}

# ---------- 1b. jq 转义:双引号/换行/中文/反斜杠,行合法且 text 往返一致 ----------

test_capture_escaping() {
  new_sandbox; local home="$SB"
  new_sandbox; local cwd="$SB"
  local inbox="$home/inbox.jsonl"
  local tricky line rc
  tricky=$'说了 "双引号" 与反斜杠 C:\\tmp\\新建\n第二行:中文、tab\t与 emoji 🙂'
  (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" note --project '转义用例' -- "$tricky"); rc=$?
  assert_eq 'escape: 捕获命令退出码 0' 0 "$rc"
  assert_eq 'escape: inbox 恰 1 行(换行被正确转义)' 1 "$(count_lines "$inbox")"
  line="$(head -n 1 "$inbox")"
  json_ok "$line"; assert_eq 'escape: 行是合法 JSON' 0 $?
  assert_eq 'escape: text 字节级往返一致' "$tricky" "$(json_field "$line" text)"
  assert_eq 'escape: 中文 project 往返一致' '转义用例' "$(json_field "$line" project)"
}

# ---------- 2. --project/--source/--redact 与 git 仓库名推断 ----------

test_capture_flags() {
  new_sandbox; local home="$SB"
  new_sandbox; local cwd="$SB"
  local inbox="$home/inbox.jsonl"
  local line repo

  (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" done --project proj-x --source 'commit:abc1234' -- '带显式来源')
  line="$(tail -n 1 "$inbox")"
  assert_eq 'flags: --project 生效' 'proj-x' "$(json_field "$line" project)"
  assert_eq 'flags: --source 生效' 'commit:abc1234' "$(json_field "$line" source)"

  (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" note --project p2 -- '缺省来源')
  line="$(tail -n 1 "$inbox")"
  assert_eq 'flags: 缺省 source=manual' manual "$(json_field "$line" source)"

  # 无 --project 且位于 git 仓库内 → 取仓库目录名
  new_sandbox
  repo="$SB/repo-under-test"
  mkdir -p "$repo"
  git -c init.defaultBranch=main init -q "$repo"
  (cd "$repo" && env WL_HOME="$home" bash "$WL_BIN" idea '仓库内想法')
  line="$(tail -n 1 "$inbox")"
  assert_eq 'flags: 无 --project 时取 git 仓库名' 'repo-under-test' "$(json_field "$line" project)"

  # --redact:sk- 密钥与邮箱替换为 [REDACTED](FR-12)
  (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" note --project p3 --redact -- 'key sk-abcdef123456 mail a.b@example.com end')
  line="$(tail -n 1 "$inbox")"
  assert_eq 'flags: --redact 替换密钥与邮箱' 'key [REDACTED] mail [REDACTED] end' "$(json_field "$line" text)"
}

# ---------- 3. flock 并发:50 后台进程,恰 50 行且无交错 ----------

test_flock_concurrency() {
  new_sandbox; local home="$SB"
  new_sandbox; local cwd="$SB"
  local inbox="$home/inbox.jsonl"
  local i line bad
  for i in $(seq 1 50); do
    (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" note --project 并发 -- "concurrent-$i") &
  done
  wait
  assert_eq 'flock: 50 并发后 inbox 恰 50 行' 50 "$(count_lines "$inbox")"
  if [ "$JSON_TOOL" = python3 ]; then
    python3 -c '
import json, sys
texts = []
with open(sys.argv[1], encoding="utf-8") as f:
    for raw in f:
        texts.append(json.loads(raw)["text"])
expected = sorted("concurrent-%d" % i for i in range(1, 51))
sys.exit(0 if sorted(texts) == expected else 1)
' "$inbox"
    assert_eq 'flock: 每行合法 JSON 且 50 条 text 完整无交错' 0 $?
  else
    bad=0
    while IFS= read -r line; do
      json_ok "$line" || bad=$((bad + 1))
    done <"$inbox"
    assert_eq 'flock: 每行都是合法 JSON(无交错)' 0 "$bad"
  fi
}

# ---------- 4. 行首契约:cut -c8-17 恰为 YYYY-MM-DD(锁 FR-2 键序) ----------

test_line_start_contract() {
  new_sandbox; local home="$SB"
  new_sandbox; local cwd="$SB"
  local before after line got
  before="$(date +%F)"
  (cd "$cwd" && env WL_HOME="$home" bash "$WL_BIN" note --project p -- '行首契约')
  after="$(date +%F)"
  line="$(head -n 1 "$home/inbox.jsonl")"
  got="$(printf '%s' "$line" | cut -c8-17)"
  if printf '%s' "$got" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'; then
    pass '行首契约: cut -c8-17 取出 YYYY-MM-DD(FR-2 键序)'
  else
    fail "行首契约: cut -c8-17 得到 [$got],非日期形状"
  fi
  if [ "$got" = "$before" ] || [ "$got" = "$after" ]; then
    pass '行首契约: 取出的日期等于当日'
  else
    fail "行首契约: [$got] 不等于当日([$before]/[$after])"
  fi
}

# ---------- 5. remind.sh:欠账判定与静默纪律 ----------

test_remind() {
  local remind="$HOOKS_DIR/remind.sh"
  local home out rc yd d2 errfile today

  # 无 inbox、无 ledger → 零输出 exit 0(AC-2,缺失即静默)
  new_sandbox; home="$SB"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind: 无 inbox 时 exit 0' 0 "$rc"
  assert_eq 'remind: 无 inbox 时零输出' '' "$out"

  # 仅今日有数据(今日未结束,不算欠账)→ 零输出
  new_sandbox; home="$SB"
  today="$(date +%F)"
  inbox_line "$today" note today-only "$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind: 仅今日有数据 exit 0' 0 "$rc"
  assert_eq 'remind: 仅今日有数据零输出' '' "$out"

  # 昨日欠账 → 输出含该日期与条数
  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done fix-a "$home/inbox.jsonl"
  inbox_line "$yd" note note-b "$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind: 单日欠账 exit 0' 0 "$rc"
  assert_contains 'remind: 注入体含 [worklog] 前缀' "$out" '[worklog]'
  assert_contains 'remind: 输出含欠账日期' "$out" "$yd"
  assert_contains 'remind: 输出含最近一日条数' "$out" '2 条'

  # 多日欠账 → 区间文案含「天」
  new_sandbox; home="$SB"
  d2="$(rel_date 2)"
  yd="$(rel_date 1)"
  inbox_line "$d2" done old-item "$home/inbox.jsonl"
  inbox_line "$yd" done new-item "$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind: 多日欠账 exit 0' 0 "$rc"
  assert_contains 'remind: 多日区间文案含「天」' "$out" '天'
  assert_contains 'remind: 多日区间含最早日期' "$out" "$d2"

  # ledger.confirmedThrough 覆盖到昨天 → 零输出
  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done confirmed-item "$home/inbox.jsonl"
  mkdir -p "$home/ledger"
  printf '{"schemaVersion":1,"confirmedThrough":"%s","todos":[],"ideas":[],"days":{}}\n' "$yd" \
    >"$home/ledger/ledger.json"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind: confirmedThrough 覆盖后 exit 0' 0 "$rc"
  assert_eq 'remind: confirmedThrough 覆盖后零输出' '' "$out"

  # --human → 以 worklog: 开头
  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done human-item "$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind" --human)"; rc=$?
  assert_eq 'remind: --human exit 0' 0 "$rc"
  case "$out" in
    worklog:*) pass 'remind: --human 输出以 worklog: 开头' ;;
    *) fail "remind: --human 输出 [$out] 未以 worklog: 开头" ;;
  esac

  # ledger 损坏 → 静默(exit 0、无 stderr),按 1970 起点回退照常判定
  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done broken-ledger-item "$home/inbox.jsonl"
  mkdir -p "$home/ledger"
  printf '{broken' >"$home/ledger/ledger.json"
  errfile="$home/stderr.txt"
  out="$(env WL_HOME="$home" sh "$remind" 2>"$errfile")"; rc=$?
  assert_eq 'remind: ledger 损坏 exit 0' 0 "$rc"
  assert_eq 'remind: ledger 损坏无 stderr' '' "$(cat "$errfile")"
  assert_contains 'remind: ledger 损坏回退后仍提醒' "$out" "$yd"
}

# ---------- 6. remind-daily.sh:日频标记,首次转发、二次零输出(AC-3 本地等价) ----------

test_remind_daily() {
  local rd="$HOOKS_DIR/remind-daily.sh"
  local home yd out rc t0 t1

  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done pending-item "$home/inbox.jsonl"

  t0="$(date +%F)"
  out="$(env WL_HOME="$home" sh "$rd")"; rc=$?
  t1="$(date +%F)"
  assert_eq 'remind-daily: 首次调用 exit 0' 0 "$rc"
  assert_contains 'remind-daily: 首次调用转发 remind 输出' "$out" "$yd"
  if [ -e "$home/state/remind-$t0" ] || [ -e "$home/state/remind-$t1" ]; then
    pass 'remind-daily: 当日标记文件已创建'
  else
    fail "remind-daily: $home/state 下无当日标记文件"
  fi

  out="$(env WL_HOME="$home" sh "$rd")"; rc=$?
  assert_eq 'remind-daily: 二次调用 exit 0(快路径)' 0 "$rc"
  assert_eq 'remind-daily: 二次调用零输出' '' "$out"
}

# ---------- 7. post-commit:捕获、merge 跳过、repos.list、链式回调、per-repo 关闭 ----------

test_post_commit() {
  new_sandbox; local home="$SB"
  new_sandbox; local repo="$SB"
  local inbox="$home/inbox.jsonl"
  local hooks_path="$HOOKS_DIR"
  local sha line top before rc parents

  # 钩子由 git 经 core.hooksPath 直接执行,需要执行位;缺失时复制到沙箱补齐(不动仓库文件)
  if [ ! -x "$HOOKS_DIR/post-commit" ]; then
    new_sandbox
    hooks_path="$SB/hooks"
    mkdir -p "$hooks_path"
    cp "$HOOKS_DIR/post-commit" "$hooks_path/post-commit"
    chmod +x "$hooks_path/post-commit"
  fi

  # 钩子按 $WL_HOME/bin/wl 定位捕获入口
  mkdir -p "$home/bin"
  cp "$WL_BIN" "$home/bin/wl"
  chmod +x "$home/bin/wl"

  git -c init.defaultBranch=main init -q "$repo"
  git -C "$repo" config user.name wl-test
  git -C "$repo" config user.email wl-test@example.invalid
  git -C "$repo" config core.hooksPath "$hooks_path"

  gitc() { # WL_HOME 与作者/提交者环境注入;gpgsign 关闭,不依赖全局配置
    env WL_HOME="$home" \
      GIT_AUTHOR_NAME=wl-test GIT_AUTHOR_EMAIL=wl-test@example.invalid \
      GIT_COMMITTER_NAME=wl-test GIT_COMMITTER_EMAIL=wl-test@example.invalid \
      git -C "$repo" -c commit.gpgsign=false "$@"
  }

  # 普通 commit → 落一行 done / commit:<短sha> / text=subject(AC-1)
  printf 'hello\n' >"$repo/a.txt"
  gitc add a.txt
  gitc commit -q -m 'feat: first change'; rc=$?
  assert_eq 'post-commit: commit 本身退出码 0(钩子不阻塞)' 0 "$rc"
  sha="$(git -C "$repo" rev-parse --short HEAD)"
  assert_eq 'post-commit: 普通 commit 落 1 行' 1 "$(count_lines "$inbox")"
  line="$(tail -n 1 "$inbox")"
  json_ok "$line"; assert_eq 'post-commit: 行是合法 JSON' 0 $?
  assert_eq 'post-commit: type=done' done "$(json_field "$line" type)"
  assert_eq 'post-commit: source=commit:<短sha>' "commit:$sha" "$(json_field "$line" source)"
  assert_eq 'post-commit: text=commit subject' 'feat: first change' "$(json_field "$line" text)"
  assert_eq 'post-commit: project=仓库目录名' "$(basename "$repo")" "$(json_field "$line" project)"

  # repos.list 登记一次
  top="$(git -C "$repo" rev-parse --show-toplevel)"
  assert_eq 'post-commit: repos.list 登记仓库路径' 1 "$(grep -cxF "$top" "$home/state/repos.list" 2>/dev/null)"

  # 重复 commit 不重复登记
  printf 'world\n' >>"$repo/a.txt"
  gitc commit -q -a -m 'feat: second change'
  assert_eq 'post-commit: 第二次 commit 追加 1 行' 2 "$(count_lines "$inbox")"
  assert_eq 'post-commit: repos.list 不重复登记' 1 "$(grep -cxF "$top" "$home/state/repos.list" 2>/dev/null)"

  # 链式回调:本地 .git/hooks/post-commit 被全局钩子调用(core.hooksPath 遮蔽场景)
  cat >"$repo/.git/hooks/post-commit" <<EOF
#!/bin/sh
: >"$home/chain.marker"
EOF
  chmod +x "$repo/.git/hooks/post-commit"
  printf 'more\n' >>"$repo/a.txt"
  gitc commit -q -a -m 'feat: third change'
  if [ -e "$home/chain.marker" ]; then
    pass 'post-commit: 链式回调执行了本地钩子'
  else
    fail 'post-commit: 本地 .git/hooks/post-commit 未被调用'
  fi
  assert_eq 'post-commit: 链式回调不影响捕获' 3 "$(count_lines "$inbox")"

  # merge commit(两分支合并;--no-commit 后 git commit 收尾,post-commit 触发但父数=2)→ 不新增行
  gitc checkout -q -b feature
  printf 'feature\n' >"$repo/b.txt"
  gitc add b.txt
  gitc commit -q -m 'feat: feature branch'
  gitc checkout -q main
  printf 'main\n' >"$repo/c.txt"
  gitc add c.txt
  gitc commit -q -m 'feat: main branch'
  before="$(count_lines "$inbox")"
  gitc merge --no-ff --no-commit -q feature >/dev/null 2>&1 # -q 仍会漏 merge 聊天信息;失败由下方双亲断言兜住
  gitc commit -q -m 'merge: feature into main'
  parents="$(git -C "$repo" rev-list --parents -n1 HEAD | wc -w | tr -d '[:space:]')"
  assert_eq 'post-commit: merge commit 确为双亲(用例前提)' 3 "$parents"
  assert_eq 'post-commit: merge commit 不落行' "$before" "$(count_lines "$inbox")"

  # per-repo 关闭:git config worklog.capture false → 不落行
  gitc config worklog.capture false
  before="$(count_lines "$inbox")"
  printf 'off\n' >>"$repo/a.txt"
  gitc commit -q -a -m 'feat: capture disabled'
  assert_eq 'post-commit: worklog.capture=false 不落行' "$before" "$(count_lines "$inbox")"
}

# ---------- 9. 提醒链路加固回归(对抗审查修复项) ----------

test_remind_hardening() {
  local remind="$HOOKS_DIR/remind.sh"
  local daily="$HOOKS_DIR/remind-daily.sh"
  local home out rc yd

  # inbox 截断残行(崩溃残迹)不得伪造欠账注入
  new_sandbox; home="$SB"
  printf '{"ts":"2026-07-2' >"$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind" 2>/dev/null)"; rc=$?
  assert_eq 'remind加固: 截断残行 exit 0' 0 "$rc"
  assert_eq 'remind加固: 截断残行零输出' '' "$out"

  # 字节 8-17 恰为日期形状的垃圾行同样不得伪造欠账
  new_sandbox; home="$SB"
  printf 'AAAAAAA2020-01-01ZZZZZ\n' >"$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind" 2>/dev/null)"; rc=$?
  assert_eq 'remind加固: 垃圾行 exit 0' 0 "$rc"
  assert_eq 'remind加固: 垃圾行零输出' '' "$out"

  # 每本地日至多注入一次:同沙箱二次调用(模拟同日新会话 SessionStart)静默
  new_sandbox; home="$SB"
  yd="$(rel_date 1)"
  inbox_line "$yd" done once-item "$home/inbox.jsonl"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_contains 'remind加固: 首次注入含欠账日期' "$out" "$yd"
  out="$(env WL_HOME="$home" sh "$remind")"; rc=$?
  assert_eq 'remind加固: 同日二次调用 exit 0' 0 "$rc"
  assert_eq 'remind加固: 同日二次调用零输出(notified 标记)' '' "$out"
  # --human 不受 notified 标记限制
  out="$(env WL_HOME="$home" sh "$remind" --human)"
  assert_contains 'remind加固: --human 不受标记限制' "$out" 'worklog:'

  # state 目录不可写:每条 prompt 必须 rc=0 且零 stderr(故障静默红线)
  new_sandbox; home="$SB"
  inbox_line "$(rel_date 1)" done quiet-item "$home/inbox.jsonl"
  mkdir -p "$home/state"
  chmod 555 "$home/state"
  local errfile="$home.err"
  out="$(env WL_HOME="$home" sh "$daily" 2>"$errfile")"; rc=$?
  chmod 755 "$home/state"
  assert_eq 'remind加固: state 只读时 remind-daily exit 0' 0 "$rc"
  assert_eq 'remind加固: state 只读时零输出' '' "$out"
  assert_eq 'remind加固: state 只读时零 stderr' '' "$(cat "$errfile")"

  # 并发首 prompt:两个 remind-daily 同时启动,至多一个产生注入(noclobber 原子建档)
  new_sandbox; home="$SB"
  inbox_line "$(rel_date 1)" done race-item "$home/inbox.jsonl"
  local out1_file="$home.out1" out2_file="$home.out2"
  env WL_HOME="$home" sh "$daily" >"$out1_file" 2>/dev/null &
  local pid1=$!
  env WL_HOME="$home" sh "$daily" >"$out2_file" 2>/dev/null &
  local pid2=$!
  wait "$pid1" "$pid2" 2>/dev/null
  local nonempty=0
  [ -s "$out1_file" ] && nonempty=$((nonempty + 1))
  [ -s "$out2_file" ] && nonempty=$((nonempty + 1))
  if [ "$nonempty" -le 1 ]; then
    pass 'remind加固: 并发首 prompt 至多一次注入'
  else
    fail "remind加固: 并发首 prompt 注入了 $nonempty 次"
  fi
}

# ---------- 入口 ----------

main() {
  local f
  for f in "$WL_BIN" "$HOOKS_DIR/post-commit" "$HOOKS_DIR/remind.sh" "$HOOKS_DIR/remind-daily.sh"; do
    if [ ! -f "$f" ]; then
      echo "hotpath.test.sh: 主线文件缺失:$f" >&2
      exit 1
    fi
  done
  if ! command -v git >/dev/null 2>&1; then
    echo 'hotpath.test.sh: 需要 git' >&2
    exit 1
  fi

  test_capture_types
  test_capture_escaping
  test_capture_flags
  test_flock_concurrency
  test_line_start_contract
  test_remind
  test_remind_daily
  test_post_commit
  test_remind_hardening

  printf '\nhotpath: %d passed, %d failed\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
}

main "$@"
