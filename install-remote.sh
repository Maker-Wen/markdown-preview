#!/bin/sh
set -eu

repository=${MARKDOWN_PREVIEW_REPOSITORY:-Maker-Wen/markdown-preview}
version=${MARKDOWN_PREVIEW_VERSION:-latest}

usage() {
  cat <<'EOF'
Markdown Preview 远程安装器

用法：
  sh install-remote.sh [--dry-run]

环境变量：
  MARKDOWN_PREVIEW_REPOSITORY  GitHub owner/repository，默认 Maker-Wen/markdown-preview
  MARKDOWN_PREVIEW_VERSION      Release 标签，默认 latest（最新正式版）

下载 Release、校验 SHA-256 并安装，默认使用最新正式版。
EOF
}

if [ "${1:-}" = '--help' ]; then
  usage
  exit 0
fi

printf '%s\n' "$repository" | LC_ALL=C awk '
  /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/ { valid=1 }
  END { exit (valid && NR == 1) ? 0 : 1 }
' || { printf '%s\n' 'MARKDOWN_PREVIEW_REPOSITORY 必须是 owner/repository。' >&2; exit 2; }

command -v curl >/dev/null 2>&1 || { printf '%s\n' '远程安装需要 curl。' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf '%s\n' '远程安装需要 tar。' >&2; exit 1; }

if [ "$version" = 'latest' ]; then
  latest_url=$(curl -fsSL --retry 3 --output /dev/null --write-out '%{url_effective}' \
    "https://github.com/${repository}/releases/latest") || {
    printf '%s\n' '无法查询最新正式版，请检查网络及仓库的 Release。' >&2
    exit 1
  }
  tag_prefix="https://github.com/${repository}/releases/tag/"
  case "$latest_url" in
    "$tag_prefix"*) version=${latest_url#"$tag_prefix"} ;;
    *) printf '%s\n' '最新正式版没有返回预期的 Release 标签地址。' >&2; exit 1 ;;
  esac
fi
case "$version" in
  v*) : ;;
  *) version="v$version" ;;
esac
printf '%s\n' "$version" | LC_ALL=C awk '
  /^v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/ { valid=1 }
  END { exit (valid && NR == 1) ? 0 : 1 }
' || { printf '%s\n' 'MARKDOWN_PREVIEW_VERSION 必须是 latest、vX.Y.Z 或 X.Y.Z。' >&2; exit 2; }
printf '%s\n' "安装版本：$version"

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
# BSD tar can restore AppleDouble data before applying exclude patterns.
# Disable that behavior when supported; GNU tar treats the files normally.
metadata_option=
if tar --no-mac-metadata --version >/dev/null 2>&1; then
  metadata_option=--no-mac-metadata
fi
tar -tzf "$tmp/$archive" > "$tmp/members" || {
  printf '%s\n' 'Release 资产包含不安全或无法识别的归档路径。' >&2
  exit 1
}
awk -v root="$root_name/" -v metadata="._$root_name" '
  $0 == metadata { next }
  index($0, root) != 1 || $0 ~ /(^|\/)\.\.?($|\/)/ || $0 ~ /^\// { bad=1 }
  END { exit bad ? 1 : 0 }
' "$tmp/members" || { printf '%s\n' 'Release 资产包含不安全的归档路径。' >&2; exit 1; }
tar ${metadata_option:+"$metadata_option"} -xzf "$tmp/$archive" -C "$tmp/extract" \
  --exclude="._$root_name" --exclude="$root_name/._*" --exclude="$root_name/*/._*"
[ -f "$tmp/extract/$root_name/install.sh" ] || { printf '%s\n' 'Release 资产缺少 install.sh。' >&2; exit 1; }
sh "$tmp/extract/$root_name/install.sh" "$@"
