#!/usr/bin/env bash
# worklog 安装器(实现方案 §7):幂等可重复执行,全程无需 root。
# 复制类步骤天然幂等——任何一步失败,修复环境后直接重跑即可,不会留下不可恢复的半安装状态。
set -euo pipefail

WL_HOME="${WL_HOME:-$HOME/.worklog}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

trap 'printf "[worklog] 错误:安装在第 %s 行失败(命令:%s)。修复后可直接重跑本脚本。\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

# 解析仓库根(本脚本位于 <repo>/scripts/install.sh;可能经软链调用)
src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  case "$src" in /*) ;; *) src="$dir/$src" ;; esac
done
REPO_ROOT="$(cd -P "$(dirname "$src")/.." && pwd)"

info() { printf '[worklog] %s\n' "$*"; }
warn() { printf '[worklog] 警告:%s\n' "$*" >&2; }
die()  { printf '[worklog] 错误:%s\n' "$*" >&2; exit 1; }

expand_tilde() {
  case "$1" in
    '~')   printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
    *)     printf '%s' "$1" ;;
  esac
}

sed_escape() { # sed 替换段转义:反斜杠、& 与分隔符 |
  printf '%s' "$1" | sed -e 's/[&\\|]/\\&/g'
}

merge_hooks_json() { # $1=既有 hooks.json $2=已展开的片段;合并结果写 stdout,失败返回非零
  # 语义:同事件数组做追加合并,按 command 字段去重;绝不删改既有条目。
  if command -v jq >/dev/null 2>&1; then
    jq --slurpfile frag "$2" '
      def cmds_of: [ .. | objects | select(has("command")) | .command ];
      ($frag[0].hooks // {}) as $fh
      | .hooks = ( (.hooks // {}) as $eh
          | reduce ($fh | keys_unsorted[]) as $k ($eh;
              .[$k] = ( (.[$k] // []) as $cur
                | ($cur | cmds_of) as $have
                | $cur + [ $fh[$k][] | . as $g
                    | select(($g | cmds_of) | any(. as $c | ($have | index($c)) == null)) ] ) ) )
    ' "$1"
  else
    python3 - "$1" "$2" <<'PYEOF'
import json, sys

def cmds(node):
    out = []
    if isinstance(node, dict):
        if 'command' in node:
            out.append(node['command'])
        for value in node.values():
            out += cmds(value)
    elif isinstance(node, list):
        for value in node:
            out += cmds(value)
    return out

with open(sys.argv[1], encoding='utf-8') as fh:
    data = json.load(fh)
with open(sys.argv[2], encoding='utf-8') as fh:
    frag = json.load(fh)
if not isinstance(data, dict):
    raise SystemExit('hooks.json top-level is not an object')
existing = data.get('hooks')
if existing is None:
    existing = {}
if not isinstance(existing, dict):
    raise SystemExit('"hooks" is not an object')
data['hooks'] = existing
for event, groups in (frag.get('hooks') or {}).items():
    current = existing.get(event)
    if current is None:
        current = []
    if not isinstance(current, list):
        raise SystemExit('hooks.%s is not an array' % event)
    have = set(cmds(current))
    for group in groups:
        commands = cmds(group)
        if not commands or all(c in have for c in commands):
            continue
        current.append(group)
        have.update(commands)
    existing[event] = current
json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
sys.stdout.write('\n')
PYEOF
  fi
}

[ -f "$REPO_ROOT/bin/wl" ] || die "找不到 $REPO_ROOT/bin/wl:请在 worklog 仓库克隆内执行 scripts/install.sh"

# ── 1/6 目录与副本(hook 配置只引用 $WL_HOME 下副本,与克隆目录解耦)──
info "==> 1/6 安装副本到 $WL_HOME"
mkdir -p "$WL_HOME"/{ledger,days,state,bin,hooks,git-hooks,scripts}

cp -f "$REPO_ROOT/bin/wl"                "$WL_HOME/bin/wl"
cp -f "$REPO_ROOT/hooks/remind.sh"       "$WL_HOME/hooks/remind.sh"
cp -f "$REPO_ROOT/hooks/remind-daily.sh" "$WL_HOME/hooks/remind-daily.sh"
cp -f "$REPO_ROOT/hooks/post-commit"     "$WL_HOME/git-hooks/post-commit"

# scripts/worklog:先整体复制到同目录下的临时名再换入,中断不会留下半份冷路径
tmp_scripts="$WL_HOME/scripts/.worklog.tmp-$$"
rm -rf "$tmp_scripts"
cp -R "$REPO_ROOT/scripts/worklog" "$tmp_scripts"
rm -rf "$WL_HOME/scripts/worklog"
mv "$tmp_scripts" "$WL_HOME/scripts/worklog"

chmod +x "$WL_HOME/bin/wl" \
         "$WL_HOME/hooks/remind.sh" "$WL_HOME/hooks/remind-daily.sh" \
         "$WL_HOME/git-hooks/post-commit"
if [ -d "$WL_HOME/scripts/worklog/bin" ]; then
  chmod +x "$WL_HOME/scripts/worklog/bin"/* 2>/dev/null || true
fi

# ── 2/6 ~/.local/bin/wl 软链 ──
info "==> 2/6 命令软链"
local_bin="$HOME/.local/bin"
link="$local_bin/wl"
mkdir -p "$local_bin"
if [ -L "$link" ]; then
  current_target="$(readlink "$link")"
  if [ "$current_target" = "$WL_HOME/bin/wl" ]; then
    info "$link 已指向 $WL_HOME/bin/wl,跳过"
  else
    info "覆盖既有软链 $link(原指向:$current_target)"
    ln -sfn "$WL_HOME/bin/wl" "$link"
  fi
elif [ -e "$link" ]; then
  info "覆盖既有文件 $link(原为普通文件,非本安装器所建)"
  rm -f "$link"
  ln -s "$WL_HOME/bin/wl" "$link"
else
  ln -s "$WL_HOME/bin/wl" "$link"
  info "已创建软链 $link → $WL_HOME/bin/wl"
fi
case ":$PATH:" in
  *":$local_bin:"*) : ;;
  *) info "提示:$local_bin 不在 PATH 中,加入后才能直接敲 wl(如在 shell rc 里 export PATH=\"\$HOME/.local/bin:\$PATH\")" ;;
esac

# ── 3/6 全局 git 钩子 ──
info "==> 3/6 全局 git 钩子"
if ! command -v git >/dev/null 2>&1; then
  warn "未找到 git,跳过 core.hooksPath 配置(commit 即捕获链路暂不可用)"
else
  current_hooks="$(git config --global --get core.hooksPath 2>/dev/null || true)"
  if [ -z "$current_hooks" ]; then
    git config --global core.hooksPath "$WL_HOME/git-hooks"
    info "已设置 git config --global core.hooksPath=$WL_HOME/git-hooks"
    warn "core.hooksPath 全局生效会遮蔽各仓库本地 .git/hooks/*(含 husky 等工具安装的钩子)"
    info "worklog 的 post-commit 已内置链式回调本地钩子:各仓库本地 post-commit 仍会执行;其他类型钩子(pre-commit 等)如有依赖,请在 $WL_HOME/git-hooks 下自行补同名转发脚本"
  elif [ "$(expand_tilde "$current_hooks")" = "$WL_HOME/git-hooks" ]; then
    info "core.hooksPath 已指向 $WL_HOME/git-hooks,跳过"
  else
    info "检测到既有 core.hooksPath=$current_hooks,绝不覆盖你的配置。"
    info "请在 $(expand_tilde "$current_hooks")/post-commit 末尾追加一行:\"$WL_HOME/git-hooks/post-commit\" \"\$@\" || true"
  fi
fi

# ── 4/6 Codex hooks ──
info "==> 4/6 Codex hooks($CODEX_HOME/hooks.json)"
hooks_target="$CODEX_HOME/hooks.json"
frag_tmp="$(mktemp "${TMPDIR:-/tmp}/wl-hooks-frag.XXXXXX")"
# 片段中的 $HOME/.worklog 展开为实际 WL_HOME 绝对路径,其余 $HOME 展开为实际 HOME
sed -e "s|\$HOME/\.worklog|$(sed_escape "$WL_HOME")|g" \
    -e "s|\$HOME|$(sed_escape "$HOME")|g" \
    "$REPO_ROOT/hooks/hooks.codex.json" >"$frag_tmp"

if [ ! -f "$hooks_target" ]; then
  mkdir -p "$CODEX_HOME"
  cp -f "$frag_tmp" "$hooks_target"
  info "已写入 $hooks_target"
else
  backup="$hooks_target.bak-$(date +%F)"
  if [ ! -e "$backup" ]; then
    cp -f "$hooks_target" "$backup"
    info "原 hooks.json 已备份为 $backup"
  fi
  merged_tmp="$(mktemp "${TMPDIR:-/tmp}/wl-hooks-merged.XXXXXX")"
  if merge_hooks_json "$hooks_target" "$frag_tmp" >"$merged_tmp"; then
    mv -f "$merged_tmp" "$hooks_target"
    info "已把 worklog hooks 合并进 $hooks_target(同事件数组按 command 去重追加,既有条目未删改)"
  else
    rm -f "$merged_tmp"
    warn "合并 $hooks_target 失败(文件可能不是合法 JSON,或 jq/python3 均不可用)。原文件未改动,请手工把以下片段合并进去:"
    cat "$frag_tmp" >&2
  fi
fi
rm -f "$frag_tmp"
info 'Codex 首次加载将请求信任该非托管 hook;请用 `codex features list` 检查 hooks 功能开关是否已开启'

# ── 5/6 全局 AGENTS.md 一行 ──
info "==> 5/6 全局 AGENTS.md"
info "请把下面这一行原样加入你的全局 AGENTS.md(本安装器绝不自动修改你的全局指令文件):"
printf '\n'
cat "$REPO_ROOT/agents-md/global-line.md"
printf '\n'

# ── 6/6 安装自检 ──
info "==> 6/6 安装自检"
WL_HOME="$WL_HOME" "$WL_HOME/bin/wl" note --project install-check -- "installed"
info "已写入一条自检记录,inbox 尾行:"
tail -n 1 "$WL_HOME/inbox.jsonl"
info "该行可留着,也可手动删掉($WL_HOME/inbox.jsonl 末行)"

info "安装完成:WL_HOME=$WL_HOME"
