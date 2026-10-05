$ErrorActionPreference = 'Stop'
$repository = if ($env:MARKDOWN_PREVIEW_REPOSITORY) { $env:MARKDOWN_PREVIEW_REPOSITORY } else { 'Maker-Wen/markdown-preview' }
$version = if ($env:MARKDOWN_PREVIEW_VERSION) { $env:MARKDOWN_PREVIEW_VERSION } else { 'latest' }

function Show-Usage {
    @'
Markdown Preview 远程安装器

用法：下载本文件后执行：
  .\install-remote.ps1 [--dry-run]

环境变量：
  MARKDOWN_PREVIEW_REPOSITORY  GitHub owner/repository，默认 Maker-Wen/markdown-preview
  MARKDOWN_PREVIEW_VERSION      Release 标签，默认 latest（最新正式版）

安装器会解析最新正式版或指定标签，下载同一版本的 Release 资产，
校验 SHA-256，然后运行包内安装器。
'@ | Write-Host
}

if ($args -contains '--help') { Show-Usage; exit 0 }
if ($repository -notmatch '\A[A-Za-z0-9._-]+/[A-Za-z0-9._-]+\z') { throw 'MARKDOWN_PREVIEW_REPOSITORY 必须是 owner/repository。' }
if ($version -eq 'latest') {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
    } catch {
        throw "无法查询最新正式版，请检查网络及仓库的 Release：$($_.Exception.Message)"
    }
    if ($release.draft -or $release.prerelease -or -not $release.tag_name) { throw '最新正式版没有返回有效的 Release 标签。' }
    $version = [string]$release.tag_name
}
if ($version -notmatch '^v') { $version = "v$version" }
if ($version -cnotmatch '\Av[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?\z') { throw 'MARKDOWN_PREVIEW_VERSION 必须是 latest、vX.Y.Z 或 X.Y.Z。' }
Write-Host "安装版本：$version"

$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("markdown-preview-remote-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archive = "markdown-preview-$version.zip"
    $base = "https://github.com/$repository/releases/download/$version"
    Invoke-WebRequest -UseBasicParsing "$base/$archive" -OutFile (Join-Path $temporary $archive)
    Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS" -OutFile (Join-Path $temporary 'SHA256SUMS')
    $line = Get-Content (Join-Path $temporary 'SHA256SUMS') | Where-Object { $_ -match "\s\*?$([regex]::Escape($archive))$" } | Select-Object -First 1
    if (-not $line) { throw "SHA256SUMS 中没有 $archive。" }
    $expected = ($line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash (Join-Path $temporary $archive) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'Release 资产 SHA-256 校验失败。' }
    Expand-Archive -LiteralPath (Join-Path $temporary $archive) -DestinationPath $temporary -Force
    $root = Join-Path $temporary "markdown-preview-$version"
    $installer = Join-Path $root 'install.ps1'
    if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw 'Release 资产缺少 install.ps1。' }
    & $installer @args
    exit $LASTEXITCODE
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
