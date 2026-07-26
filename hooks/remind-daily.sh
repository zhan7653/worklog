#!/bin/sh
# UserPromptSubmit 快路径:标记文件存在即一次 stat 退出;每本地日至多一次真实检查(AC-3)。
WL_HOME="${WL_HOME:-$HOME/.worklog}"
today="$(date +%F)"
marker="$WL_HOME/state/remind-$today"
[ -e "$marker" ] && exit 0
mkdir -p "$WL_HOME/state" 2>/dev/null || exit 0
# noclobber 原子建档:并发 prompt 只有一个赢得真实检查;建档失败(已存在/不可写)一律静默。
# 注意不能用 ':'——POSIX 特殊内建的重定向失败会中止 dash 且错误先于 2>/dev/null 泄漏。
( set -C; true >"$marker" ) 2>/dev/null || exit 0
find "$WL_HOME/state" \( -name 'remind-*' -o -name 'notified-*' \) -mtime +7 -delete 2>/dev/null

dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || exit 0
if [ -x "$dir/remind.sh" ]; then
  exec "$dir/remind.sh"
fi
if [ -x "$WL_HOME/hooks/remind.sh" ]; then
  exec "$WL_HOME/hooks/remind.sh"
fi
exit 0
