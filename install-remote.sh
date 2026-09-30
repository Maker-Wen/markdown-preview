#!/bin/sh
set -eu

repository=${MARKDOWN_PREVIEW_REPOSITORY:-Maker-Wen/markdown-preview}
version=${MARKDOWN_PREVIEW_VERSION:-v1.0.0}

usage() {
  cat <<'EOF'
Markdown Preview 远程安装器

用法：下载本文件后执行：
  sh install-remote.sh [--dry-run]

环境变量：
  MARKDOWN_PREVIEW_REPOSITORY  GitHub owner/repository，默认 Maker-Wen/markdown-preview
  MARKDOWN_PREVIEW_VERSION      Release 标签，默认 v1.0.0

安装器会下载固定版本 Release 资产，校验 SHA-256，然后运行包内安装器。
EOF
}

if [ "${1:-}" = '--help' ]; then
  usage
  exit 0
fi

case "$repository" in
  [A-Za-z0-9._-]*/[A-Za-z0-9._-]*) : ;;
  *) printf '%s\n' 'MARKDOWN_PREVIEW_REPOSITORY 必须是 owner/repository。' >&2; exit 2 ;;
esac
case "$version" in
  v[0-9]*.[0-9]*.[0-9]*) : ;;
  [0-9]*.[0-9]*.[0-9]*) version="v$version" ;;
  *) printf '%s\n' 'MARKDOWN_PREVIEW_VERSION 必须是 vX.Y.Z 或 X.Y.Z。' >&2; exit 2 ;;
esac

command -v curl >/dev/null 2>&1 || { printf '%s\n' '远程安装需要 curl。' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' '远程安装需要 tar。' >&2; exit 1; }

tmp=$(mktemp -d "${TMPDIR:-/tmp}/markdown-preview-remote.XXXXXX")
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT HUP INT TERM

archive="markdown-preview-${version}.tar.gz"
base="https://github.com/${repository}/releases/download/${version}"
curl -fsSL --retry 3 "$base/$archive" -o "$tmp/$archive"
curl -fsSL --retry 3 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"

expected=$(awk -v name="$archive" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || { printf '%s\n' "SHA256SUMS 中没有 $archive。" >&2; exit 1; }
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$archive" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$archive" | awk '{ print $1 }')
else
  printf '%s\n' '远程安装需要 shasum 或 sha256sum。' >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { printf '%s\n' 'Release 资产 SHA-256 校验失败。' >&2; exit 1; }

root_name="markdown-preview-${version}"
mkdir "$tmp/extract"
tar -tzf "$tmp/$archive" | awk -v root="$root_name/" '
  $0 !~ "^" root || $0 ~ "(^|/)\.\.?(/|$)" || $0 ~ "^/" { bad=1 }
  END { exit bad ? 1 : 0 }
' || { printf '%s\n' 'Release 资产包含不安全的归档路径。' >&2; exit 1; }
tar -xzf "$tmp/$archive" -C "$tmp/extract"
[ -f "$tmp/extract/$root_name/install.sh" ] || { printf '%s\n' 'Release 资产缺少 install.sh。' >&2; exit 1; }
exec sh "$tmp/extract/$root_name/install.sh" "$@"
