#!/bin/sh
# 欠账判定与提醒注入(FR-10)。无欠账零输出零注入(AC-2);任何故障静默 exit 0。
WL_HOME="${WL_HOME:-$HOME/.worklog}"
LEDGER="$WL_HOME/ledger/ledger.json"
INBOX="$WL_HOME/inbox.jsonl"
today="$(date +%F)"

confirmed=""
if [ -f "$LEDGER" ]; then
  if command -v jq >/dev/null 2>&1; then
    confirmed="$(jq -r '.confirmedThrough // empty' "$LEDGER" 2>/dev/null)" || confirmed=""
  elif command -v python3 >/dev/null 2>&1; then
    confirmed="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("confirmedThrough",""))' "$LEDGER" 2>/dev/null)" || confirmed=""
  fi
fi
[ -n "$confirmed" ] || confirmed="1970-01-01"

# 有数据的日期 = inbox 各行 ts 的日期部分(升序去重),取 (confirmed, today) 开区间。
# 行首契约:{"ts":"YYYY-MM-DD…" → 日期恰在第 8-17 字符(FR-2 固定键序;测试锁定该假设)。
days="$(cut -c8-17 "$INBOX" 2>/dev/null | sort -u \
        | awk -v a="$confirmed" -v b="$today" '$0 > a && $0 < b')" || days=""
if [ -z "$days" ]; then
  # hook 模式零输出零注入(AC-2);--human 给人一句确认
  [ "${1:-}" = "--human" ] && printf 'worklog:无未确认欠账\n'
  exit 0
fi

n="$(printf '%s\n' "$days" | wc -l | tr -d ' ')"
first="$(printf '%s\n' "$days" | head -1)"
last="$(printf '%s\n' "$days" | tail -1)"
if [ "$n" -eq 1 ]; then span="$first"; else span="$first – $last($n 天)"; fi
count="$(grep -c "\"ts\":\"$last" "$INBOX" 2>/dev/null)" || count=0

if [ "${1:-}" = "--human" ]; then
  printf 'worklog:%s 未确认,最近一日 %s 条\n' "$span" "$count"
  exit 0
fi
# 注入体自带交互纪律,纪律不进全局 AGENTS.md(设计规格 FR-10)
printf '[worklog] %s 有未确认记录(最近一日 %s 条)。仅在答完用户当前请求后用一句话附带提及;用户未回应则今日不再提。与当前任务无关时勿展开。\n' "$span" "$count"
