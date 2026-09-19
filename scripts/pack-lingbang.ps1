<#
.SYNOPSIS
  构建 @void/void-dsh-control，装配到 dist/lingbang，并产出可安装的 tarball。

.DESCRIPTION
  与 scripts/pack-all.ps1 同一套约定，区别是本包不在主 pnpm workspace 内
  （见 docs/灵榜会话功能实现方案计划.md §20.1），因此单独 install / build。

  步骤：
    1. pnpm --dir packages/void-dsh-control install   （独立解析根）
    2. pnpm --dir packages/void-dsh-control run build （tsc -> lib/）
    3. 把 package.json / lib / cordis.patch.yml / README.md 装配到 dist/lingbang
    4. pnpm pack 产出 dist/lingbang/void-void-dsh-control-<version>.tgz
    5. 校验产物完整性

  **为什么要 tarball**：dsh 的模块回退（$DSH_HOME/profiles/node_modules）只覆盖
  profile 内部路径。`dsh plugin add <目录>` 会装成 `link:`（符号链接），Node 按真实
  路径解析该包的 bare import，父级向上查找永远到不了 profile 的 node_modules，
  于是 `@deepseek-ai/cordis` 等 peer 解析失败、profile 启动报 ERR_MODULE_NOT_FOUND。
  用 tarball 安装时 pnpm 会把包放进 profile 自己的 node_modules，父级查找即可命中
  安装依赖闭包。实测：目录安装失败，tarball 安装通过（见方案文档 §22.4）。

  旧的 dist/lingbang 不会被删除，而是移动到 dist/.trash/lingbang-<时间戳>，
  以便误操作后可以找回。

.PARAMETER SkipInstall
  跳过 pnpm install（依赖已就绪时加快速度）。

.PARAMETER DryRun
  只打印将要执行的动作，不写入任何文件。

.EXAMPLE
  pwsh -File scripts/pack-lingbang.ps1
.EXAMPLE
  pwsh -File scripts/pack-lingbang.ps1 -SkipInstall -DryRun
#>
[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "packages\void-dsh-control"
$dist = Join-Path $root "dist"
$out = Join-Path $dist "lingbang"
$trash = Join-Path $dist ".trash"

# --- 路径安全：只允许操作仓库内 dist/lingbang ------------------------------
if (-not (Test-Path $src)) { throw "源码目录不存在：$src" }
$resolvedOut = [System.IO.Path]::GetFullPath($out)
$resolvedDist = [System.IO.Path]::GetFullPath($dist)
if (-not $resolvedOut.StartsWith($resolvedDist + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "拒绝操作 dist 之外的路径：$resolvedOut"
}

$artifacts = @("package.json", "cordis.patch.yml", "README.md")

Write-Host "== lingbang 装配 ==" -ForegroundColor Cyan
Write-Host "源码：$src"
Write-Host "产物：$resolvedOut"
if ($DryRun) { Write-Host "模式：DryRun（不写入）" -ForegroundColor Yellow }

# --- 1. 依赖 ----------------------------------------------------------------
if (-not $SkipInstall) {
  Write-Host "`n[1/5] 安装依赖（独立解析根）..." -ForegroundColor Cyan
  if ($DryRun) { Write-Host "  pnpm --dir `"$src`" install" } else { pnpm --dir $src install }
} else {
  Write-Host "`n[1/5] 跳过依赖安装（-SkipInstall）" -ForegroundColor DarkGray
}

# --- 2. 构建 ----------------------------------------------------------------
Write-Host "`n[2/5] 构建（tsc -> lib/）..." -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "  pnpm --dir `"$src`" run build"
} else {
  pnpm --dir $src run build
  $lib = Join-Path $src "lib"
  if (-not (Test-Path (Join-Path $lib "index.js"))) { throw "构建未产出 lib/index.js" }
}

# --- 3. 装配 ----------------------------------------------------------------
Write-Host "`n[3/5] 装配产物..." -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "  归档旧产物 -> $trash\lingbang-<时间戳>"
  Write-Host "  New-Item -ItemType Directory -Force `"$resolvedOut`""
  foreach ($name in @("lib") + $artifacts) { Write-Host "  复制 $name" }
} else {
  if (Test-Path $resolvedOut) {
    New-Item -ItemType Directory -Force $trash | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $archived = Join-Path $trash "lingbang-$stamp"
    Move-Item -Path $resolvedOut -Destination $archived
    Write-Host "  旧产物已归档：$archived" -ForegroundColor DarkGray
  }
  New-Item -ItemType Directory -Force $resolvedOut | Out-Null
  Copy-Item -Path (Join-Path $src "lib") -Destination $resolvedOut -Recurse
  foreach ($name in $artifacts) {
    $from = Join-Path $src $name
    if (-not (Test-Path $from)) { throw "缺少装配文件：$from" }
    Copy-Item -Path $from -Destination $resolvedOut
  }
}

# --- 4. 打包 tarball（安装载体） --------------------------------------------
Write-Host "`n[4/5] 打包 tarball..." -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "  pnpm --dir `"$src`" pack --pack-destination `"$resolvedOut`""
} else {
  Push-Location $src
  try {
    pnpm pack --pack-destination $resolvedOut | Out-Null
  } finally {
    Pop-Location
  }
  $tarballs = @(Get-ChildItem $resolvedOut -Filter "void-void-dsh-control-*.tgz")
  if ($tarballs.Count -ne 1) { throw "tarball 产出异常，找到 $($tarballs.Count) 个" }
  Write-Host "  $($tarballs[0].Name)" -ForegroundColor DarkGray
}

# --- 5. 校验 ----------------------------------------------------------------
Write-Host "`n[5/5] 校验..." -ForegroundColor Cyan
if ($DryRun) {
  Write-Host "  校验 package.json / lib/index.js / cordis.patch.yml / README.md / tarball"
  Write-Host "`nDryRun 完成。" -ForegroundColor Yellow
  exit 0
}

$manifestPath = Join-Path $resolvedOut "package.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$patchRel = $manifest.dsh.bundle.patch
if (-not $patchRel) { throw "package.json 缺少 dsh.bundle.patch" }
if (-not (Test-Path (Join-Path $resolvedOut $patchRel))) { throw "dsh.bundle.patch 指向的文件不存在：$patchRel" }
if (-not (Test-Path (Join-Path $resolvedOut "lib\index.js"))) { throw "缺少 lib/index.js" }
if (-not (Test-Path (Join-Path $resolvedOut "README.md"))) { throw "缺少 README.md" }

Write-Host "  OK：$($manifest.name)@$($manifest.version)" -ForegroundColor Green
Write-Host "  bundle patch：$patchRel" -ForegroundColor Green
Write-Host "`n完成 -> $resolvedOut" -ForegroundColor Green
Write-Host "安装（必须用 tarball，不要用目录）：" -ForegroundColor Green
Write-Host "  dsh plugin --profile <profile> add `"$resolvedOut\$($tarballs[0].Name)`"" -ForegroundColor Green
