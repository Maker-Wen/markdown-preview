$ErrorActionPreference = 'Stop'

$node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
if (-not $node) {
    [Console]::Error.WriteLine('安装需要 Node.js 22.12.0 或更新版本，请先从 https://nodejs.org/ 安装 Node.js。')
    exit 1
}

& $node.Path -e 'const [major, minor] = process.versions.node.split(/\./).map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)'
if ($LASTEXITCODE -ne 0) {
    [Console]::Error.WriteLine('安装需要 Node.js 22.12.0 或更新版本，请从 https://nodejs.org/ 更新 Node.js。')
    exit 1
}

$installer = Join-Path $PSScriptRoot 'scripts/install.cjs'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    [Console]::Error.WriteLine('找不到 scripts/install.cjs，请下载完整仓库后运行此安装入口。')
    exit 1
}

& $node.Path $installer @args
exit $LASTEXITCODE
