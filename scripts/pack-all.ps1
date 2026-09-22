<#
.SYNOPSIS
  构建并打包所有 Void 包到 dist/。

.DESCRIPTION
  顺序是「逐包构建 → 归档上一轮 tarball → 逐包 pnpm pack」。

  **为什么要显式构建**：pnpm pack 只把 lib/ 现成的文件打进 tarball，不编译。
  漏掉构建这一步，打出来的就是上一次构建的旧代码——而且是静默的：命令成功、
  tarball 时间戳是新的，只有安装后行为对不上才发现。本脚本此前正缺这一步。

  归档而不是删除：上一轮 tarball 移到 dist/.trash/pack-<时间戳>/，误操作后可找回。
  仓库规则要求删除一律走回收站，脚本不得硬删。

  @void/void-memory 已按方案 B 内嵌 Star 快照，无需再单独打包快照包。

.PARAMETER SkipBuild
  跳过构建，只打包（依赖已构建好时加快速度，有打出旧代码的风险）。

.PARAMETER DryRun
  只打印将要执行的动作，不写入任何文件、不移动任何文件。

.EXAMPLE
  pwsh -File scripts/pack-all.ps1
.EXAMPLE
  pwsh -File scripts/pack-all.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$trash = Join-Path $dist ".trash"

# 依赖顺序：先基础插件，再组合 bundle。void-soul 排在 memory/legion 之前——那两个包
# 依赖它（记忆的数据根解析、军团的身份图都来自 soul），漏掉它会打出一份装不起来的
# 组合包：memory/legion 的 tarball 在，被依赖的 soul 不在。
$packages = @(
  "packages/void-soul",
  "packages/void-memory",
  "packages/void-tools",
  "packages/void-legion",
  "packages/void-channel-feishu",
  "packages/void-entry",
  "packages/void"
)

# 不在上面这个列表里的包，构建链也在这条链之外。静默漏掉它们的后果是打出发旧的
# tarball——命令成功、产物是旧的。目前只有 void-dsh-control 属于这种情况：它被
# pnpm-workspace 排除，必须单独跑 scripts/pack-lingbang.ps1。末尾会比对 src 与 lib
# 的时间戳主动提醒。
$externallyBuilt = @{
  "packages/void-dsh-control" = "scripts/pack-lingbang.ps1"
}

Write-Host "== Void 构建 + 打包 ==" -ForegroundColor Cyan
Write-Host "产物目录：$dist"
if ($SkipBuild) { Write-Host "模式：跳过构建（-SkipBuild）" -ForegroundColor Yellow }
if ($DryRun) { Write-Host "模式：DryRun（不写入）" -ForegroundColor Yellow }

# --- 1. 逐包构建 -------------------------------------------------------------
Write-Host "`n[1/3] 构建..." -ForegroundColor Cyan
$built = 0
$skipped = @()
foreach ($p in $packages) {
  $dir = Join-Path $root $p
  if (-not (Test-Path $dir)) { throw "包目录不存在：$dir" }

  $manifestPath = Join-Path $dir "package.json"
  if (-not (Test-Path $manifestPath)) { throw "缺少 package.json：$manifestPath" }
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

  # 有的包是纯 bundle 聚合（如 packages/void），没有代码可编译。
  if (-not $manifest.scripts.build) {
    Write-Host "  跳过 $($manifest.name)（无 build 脚本）" -ForegroundColor DarkGray
    $skipped += $manifest.name
    continue
  }

  if ($SkipBuild) {
    Write-Host "  跳过 $($manifest.name)（-SkipBuild）" -ForegroundColor DarkGray
    continue
  }

  Write-Host "  构建 $($manifest.name) ..." -ForegroundColor DarkGray
  if ($DryRun) {
    Write-Host "    pnpm --dir `"$p`" run build"
  } else {
    pnpm --dir $dir run build
    if ($LASTEXITCODE -ne 0) { throw "构建失败：$($manifest.name)（退出码 $LASTEXITCODE）" }
  }
  $built++
}

# --- 2. 归档上一轮 tarball ---------------------------------------------------
Write-Host "`n[2/3] 归档旧 tarball..." -ForegroundColor Cyan
$old = @(Get-ChildItem $dist -Filter '*.tgz' -File -ErrorAction SilentlyContinue)
if ($old.Count -eq 0) {
  Write-Host "  没有需要归档的 tarball" -ForegroundColor DarkGray
} elseif ($DryRun) {
  Write-Host "  将 $($old.Count) 个 tarball 移到 $trash\pack-<时间戳>\"
  $old | ForEach-Object { Write-Host "    $($_.Name)" }
} else {
  New-Item -ItemType Directory -Force $trash | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $archived = Join-Path $trash "pack-$stamp"
  New-Item -ItemType Directory -Force $archived | Out-Null
  $old | Move-Item -Destination $archived
  Write-Host "  $($old.Count) 个旧 tarball 已归档：$archived" -ForegroundColor DarkGray
}

# --- 3. 逐包打包 -------------------------------------------------------------
Write-Host "`n[3/3] 打包..." -ForegroundColor Cyan
foreach ($p in $packages) {
  $manifest = Get-Content (Join-Path $root "$p\package.json") -Raw | ConvertFrom-Json
  if ($DryRun) {
    Write-Host "  pnpm --dir `"$p`" pack --pack-destination `"$dist`""
    continue
  }
  Push-Location (Join-Path $root $p)
  try {
    pnpm pack --pack-destination $dist | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "打包失败：$($manifest.name)（退出码 $LASTEXITCODE）" }
  } finally {
    Pop-Location
  }
}

if ($DryRun) {
  Write-Host "`nDryRun 完成。" -ForegroundColor Yellow
  exit 0
}

# --- 汇总 --------------------------------------------------------------------
$tarballs = @(Get-ChildItem $dist -Filter '*.tgz' -File | Sort-Object Name)
Write-Host "`n完成：构建 $built 个包，产出 $($tarballs.Count) 个 tarball -> $dist" -ForegroundColor Green


$tarballs | ForEach-Object { Write-Host "  $($_.Name)" }
if ($skipped.Count -gt 0) {
  Write-Host "（无 build 脚本：$($skipped -join ', ')）" -ForegroundColor DarkGray
}
# 不在本脚本包列表里的包，构建链也在这条链之外。静默漏掉它们的后果是打出发旧的
# tarball——命令成功、产物是旧的。目前只有 void-dsh-control 属于这种情况（被
# pnpm-workspace 排除），这里比对 src 与 lib 的时间戳主动提醒。
foreach ($entry in $externallyBuilt.GetEnumerator()) {
  $dir = Join-Path $root $entry.Key
  if (-not (Test-Path $dir)) { continue }
  $manifest = Get-Content (Join-Path $dir "package.json") -Raw | ConvertFrom-Json
  $newestSrc = Get-ChildItem (Join-Path $dir "src") -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $newestLib = Get-ChildItem (Join-Path $dir "lib") -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newestSrc -and (-not $newestLib -or $newestSrc.LastWriteTime -gt $newestLib.LastWriteTime)) {
    Write-Host "  [!] $($manifest.name) 的 src 比 lib 新，但本脚本不管它" -ForegroundColor Yellow
    Write-Host "      请另跑：pwsh -File $($entry.Value)" -ForegroundColor Yellow
  }
}
Write-Host "`n安装（必须用 tarball，不要用目录）：" -ForegroundColor Green
Write-Host "  dsh plugin --profile <profile> add `"$dist\<name>.tgz`"" -ForegroundColor Green
Write-Host "  路径必须写绝对路径；装 memory/legion 前先在 profile 的 package.json 里加" -ForegroundColor DarkGray
Write-Host "  pnpm.overrides（@void/void-soul 未发布）+ pnpm.onlyBuiltDependencies: [better-sqlite3]；" -ForegroundColor DarkGray
Write-Host "  重打包后要先删 profile 的 pnpm-lock.yaml 与 node_modules/，否则 add 不会换文件。" -ForegroundColor DarkGray
Write-Host "  详见 Void使用指南.md 2.6。" -ForegroundColor DarkGray
