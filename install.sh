#!/bin/sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '安装需要 Node.js 20.3.0 或更新版本，请先从 https://nodejs.org/ 安装 Node.js。' >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 3) ? 0 : 1)'; then
  printf '%s\n' '安装需要 Node.js 20.3.0 或更新版本，请从 https://nodejs.org/ 更新 Node.js。' >&2
  exit 1
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
installer="$script_dir/scripts/install.cjs"
if [ ! -f "$installer" ]; then
  printf '%s\n' '找不到 scripts/install.cjs，请下载完整仓库后运行此安装入口。' >&2
  exit 1
fi

exec node "$installer" "$@"
