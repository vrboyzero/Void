<#
.SYNOPSIS
  把桌面版（desktop profile）的 Void 包升级到 B8 版本：soul / entry / legion。

.DESCRIPTION
  只改 `~/.dsh/profiles/desktop`，不碰 `web` profile，也不碰 `void-memory`
  （新包与已装内容逐字节一致，且它是 better-sqlite3 原生模块，能不动就不动）。

  为什么要这个脚本，而不是直接 `dsh plugin add`：
  1. desktop 的 package.json 与 pnpm-workspace.yaml 现在指向 `-r2` / `-r3` 两个
     已被归档、甚至不存在的 tarball；直接 install 会失败。脚本改成新的 `-b8` 名。
  2. `file:` tarball 同名重打会被 pnpm 判成「没变化」；换新名是最省事的强制方式
     （2026-10-29 的教训，见 profiles/desktop/pnpm-workspace.yaml 注释）。
  3. 升级后 B1 派活名单默认 fail-closed（没有名单 = 没人能派活）。脚本会在名单
     文件不存在时**预置**一份（默认 belldandy + dagon），并用军团自己的解析器校验；
     已有名单则绝不覆盖。

  默认是 dry-run，只打印将要做什么；加 `-Apply` 才真正写入。
  执行前必须**完全退出 DeepSeek Harness 桌面应用**（脚本会检查并拒绝）。

.PARAMETER Apply
  真正执行：备份 → 改 specifier → 预置名单 → pnpm install → 按内容核对。

.PARAMETER Force
  跳过「桌面应用仍在运行」的检查。不推荐：安装期间应用可能持有文件。

.PARAMETER PolicyAgents
  预置到派活名单的档案 id，逗号分隔。默认 `belldandy,dagon`。仅在名单文件不存在时生效。

.PARAMETER SkipPolicy
  不预置派活名单（升级后自己在面板里配置）。

.EXAMPLE
  pwsh -File scripts/upgrade-desktop-profile.ps1
  # 看一遍计划，不动任何文件

.EXAMPLE
  pwsh -File scripts/upgrade-desktop-profile.ps1 -Apply
  # 关掉桌面应用之后执行
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Force,
  [string[]]$PolicyAgents = @("belldandy", "dagon"),
  [switch]$SkipPolicy,
  [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop"),
  [string]$DataRoot = (Join-Path $env:USERPROFILE ".dsh\void-data\desktop")
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path $root ".tmp\rollback-desktop-$stamp"
$log = Join-Path $root ".tmp\desktop-upgrade-$stamp.log"
$policyPath = Join-Path $DataRoot "legion\dispatch-policy.json"

# 只动这三个包；memory 内容零差异，pstack 与 dsh-control 也不动。
$specs = [ordered]@{
  "void-soul"   = @{ old = "void-void-soul-0.1.0-r2.tgz";   new = "void-void-soul-0.1.0-b8.tgz" }
  "void-entry"  = @{ old = "void-void-entry-0.1.0-r2.tgz";  new = "void-void-entry-0.1.0-b8.tgz" }
  "void-legion" = @{ old = "void-void-legion-0.1.0-r3.tgz"; new = "void-void-legion-0.1.0-b8.tgz" }
}
$expectedCounts = @{ "void-soul" = 49; "void-entry" = 48; "void-legion" = 73 }

function Write-Step([string]$text) {
  Write-Host ""
  Write-Host "== $text ==" -ForegroundColor Cyan
}

function Write-Action([string]$text) {
  $prefix = if ($Apply) { "  [执行] " } else { "  [dry-run] " }
  Write-Host "$prefix$text"
}

function Get-PackageFileCount([string]$dir) {
  $nested = $dir.TrimEnd("\") + "\node_modules\"
  return @(Get-ChildItem $dir -Recurse -File | Where-Object { -not $_.FullName.StartsWith($nested) }).Count
}

function Get-TreeSignature([string]$dir) {
  $lines = Get-ChildItem $dir -Recurse -File |
    Sort-Object FullName |
    ForEach-Object {
      $rel = $_.FullName.Substring($dir.Length + 1)
      $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
      "$rel`t$($_.Length)`t$hash"
    }
  $text = ($lines -join "`n")
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLower()
}

function New-PolicyJson {
  param([string[]]$Agents, [string]$Detail)
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $doc = [ordered]@{
    schemaVersion = 1
    revision      = 0
    updatedAt     = $now
    updatedBy     = "owner"
    mode          = "owner"
    allowlist     = @($Agents)
    grants        = @()
    history       = @([ordered]@{ at = $now; action = "save"; actor = "owner"; detail = $Detail })
  }
  return ($doc | ConvertTo-Json -Depth 6)
}

function Test-PolicyJson([string]$json, [string]$where) {
  $tmp = Join-Path $root ".tmp\policy-validate-$stamp.json"
  Set-Content -Path $tmp -Value $json -Encoding utf8
  try {
    Push-Location $root
    try {
      node --input-type=module -e "import { readFileSync } from 'node:fs'; import { parseDispatchPolicyDocument } from './packages/void-legion/lib/dispatch-policy.js'; const d = parseDispatchPolicyDocument(readFileSync(process.argv[1], 'utf8')); console.log('名单校验通过: mode=' + d.mode + ' allowlist=' + d.allowlist.join(','));" $tmp
      if ($LASTEXITCODE -ne 0) { throw "派活名单解析器拒绝了 $where 生成的内容" }
    } finally {
      Pop-Location
    }
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force }
  }
}

Write-Host "Void 桌面 profile 升级（B8）" -ForegroundColor Green
Write-Host "模式：$(if ($Apply) { 'APPLY（会写文件）' } else { 'DRY-RUN（只打印）' })"
Write-Host "profile：$ProfileDir"
Write-Host "数据根：$DataRoot"

# ── 0. 前置检查 ────────────────────────────────────────────────────────────
Write-Step "0/6 前置检查"
if (-not (Test-Path $ProfileDir)) { throw "profile 不存在：$ProfileDir" }
$profileFull = (Resolve-Path $ProfileDir).Path
if ($profileFull -notmatch '\\profiles\\desktop$') {
  throw "这个脚本只允许升级 profile\desktop（当前解析到 $profileFull）；web profile 不在本次范围。"
}
foreach ($file in @("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "cordis.patch.yml")) {
  if (-not (Test-Path (Join-Path $profileFull $file))) { throw "profile 缺少 $file" }
}
Write-Action "profile 文件齐全（package.json / pnpm-workspace.yaml / pnpm-lock.yaml / cordis.patch.yml）"

foreach ($name in $specs.Keys) {
  $tarball = Join-Path $dist $specs[$name].new
  if (-not (Test-Path $tarball)) { throw "缺少 tarball：$tarball（先在本仓库执行 pnpm pack）" }
  $sha = (Get-FileHash $tarball -Algorithm SHA512).Hash.ToLower()
  Write-Action "$name -> $($specs[$name].new)（$((Get-Item $tarball).Length) B, sha512 $($sha.Substring(0,16))…）"
}

$hostProc = Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'dsh-desktop-host' }
if ($hostProc -and -not $Force) {
  throw "桌面应用还在运行（PID $($hostProc.ProcessId -join ',')）。请先完全退出 DeepSeek Harness，再重新运行；确实要热装请加 -Force。"
}
if ($hostProc) {
  Write-Host "  [!] 桌面应用仍在运行，但指定了 -Force，继续。" -ForegroundColor Yellow
} else {
  Write-Action "桌面应用未运行（符合要求）"
}

# ── 1. 备份 ────────────────────────────────────────────────────────────────
Write-Step "1/6 备份"
if ($Apply) {
  New-Item -ItemType Directory -Force $backup | Out-Null
  foreach ($file in @("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "cordis.patch.yml")) {
    Copy-Item (Join-Path $profileFull $file) (Join-Path $backup $file) -Force
  }
  foreach ($name in $specs.Keys) {
    $src = Join-Path $profileFull "node_modules\@void\$name"
    if (-not (Test-Path $src)) { throw "要备份的包不存在：$src" }
    Copy-Item $src (Join-Path $backup $name) -Recurse -Force
  }
  if (Test-Path $policyPath) {
    Copy-Item $policyPath (Join-Path $backup "dispatch-policy.before.json") -Force
  }
  $manifest = @()
  foreach ($name in $specs.Keys) {
    $dir = Join-Path $profileFull "node_modules\@void\$name"
    $manifest += "$name files=$(Get-PackageFileCount $dir) signature=$(Get-TreeSignature $dir)"
  }
  $manifest | Set-Content (Join-Path $backup "manifest.txt") -Encoding utf8
  Write-Action "已备份到 $backup"
} else {
  Write-Action "将备份 profile 四件套 + soul/entry/legion 三个包目录到 $backup"
}
Write-Action "回滚说明会写到 $backup\ROLLBACK.txt"

# ── 2. 改 specifier ───────────────────────────────────────────────────────
Write-Step "2/6 改 package.json 与 pnpm-workspace.yaml 的文件引用"
$pkgPath = Join-Path $profileFull "package.json"
$wsPath = Join-Path $profileFull "pnpm-workspace.yaml"
$pkgText = Get-Content $pkgPath -Raw
$wsText = Get-Content $wsPath -Raw

$pkgNew = $pkgText
foreach ($name in $specs.Keys) {
  $old = $specs[$name].old
  $new = $specs[$name].new
  $count = ([regex]::Matches($pkgNew, [regex]::Escape($old))).Count
  if ($count -ne 1) { throw "package.json 里 $old 应恰好出现 1 次，实际 $count 次；先人工核对。" }
  $pkgNew = $pkgNew.Replace($old, $new)
  Write-Action "package.json：$old -> $new"
}

$soulOld = $specs["void-soul"].old
$soulNew = $specs["void-soul"].new
$wsCount = ([regex]::Matches($wsText, [regex]::Escape($soulOld))).Count
if ($wsCount -ne 1) { throw "pnpm-workspace.yaml 里 $soulOld 应恰好出现 1 次，实际 $wsCount 次；先人工核对。" }
$wsNew = $wsText.Replace($soulOld, $soulNew)
Write-Action "pnpm-workspace.yaml：override $soulOld -> $soulNew"

# ── 3. 预置派活名单（仅当不存在） ──────────────────────────────────────────
Write-Step "3/6 派活名单（B1 fail-closed）"
if ($SkipPolicy) {
  Write-Action "跳过了（-SkipPolicy）：升级后军团会拒绝一切派活，直到面板里配置名单。"
} elseif (Test-Path $policyPath) {
  Write-Action "已存在 $policyPath，不覆盖（升级后沿用现有名单）。"
} else {
  $policyJson = New-PolicyJson -Agents $PolicyAgents -Detail ("B8 升级时预置名单：" + ($PolicyAgents -join ", "))
  Write-Action "将预置名单：$($PolicyAgents -join ', ')（mode=owner, revision=0）"
  Test-PolicyJson -json $policyJson -where $policyPath
}

# ── 4. 写入并安装 ─────────────────────────────────────────────────────────
Write-Step "4/6 写入与 pnpm install"
if ($Apply) {
  Set-Content -Path $pkgPath -Value $pkgNew -Encoding utf8 -NoNewline
  Set-Content -Path $wsPath -Value $wsNew -Encoding utf8 -NoNewline
  if (-not $SkipPolicy -and -not (Test-Path $policyPath)) {
    New-Item -ItemType Directory -Force (Split-Path $policyPath) | Out-Null
    Set-Content -Path $policyPath -Value $policyJson -Encoding utf8 -NoNewline
  }
  Push-Location $profileFull
  try {
    Write-Host "  pnpm install（日志：$log）" -ForegroundColor DarkGray
    & pnpm install *>&1 | Tee-Object -FilePath $log -Append | ForEach-Object { Write-Host "    $_" }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
  }
  if ($code -ne 0) {
    Copy-Item (Join-Path $backup "package.json") $pkgPath -Force
    Copy-Item (Join-Path $backup "pnpm-workspace.yaml") $wsPath -Force
    Copy-Item (Join-Path $backup "pnpm-lock.yaml") (Join-Path $profileFull "pnpm-lock.yaml") -Force
    throw "pnpm install 退出码 $code。已把 package.json / pnpm-workspace.yaml / pnpm-lock.yaml 回滚；node_modules 可能半更，按 $backup\ROLLBACK.txt 恢复三个包目录。"
  }
} else {
  Write-Action "将写入 package.json 与 pnpm-workspace.yaml，并在 $policyPath 预置名单"
  Write-Action "将在 $profileFull 执行 pnpm install"
}

# ── 5. 按内容核对 ─────────────────────────────────────────────────────────
Write-Step "5/6 按内容核对（不看命令是否成功）"
$failures = @()
if ($Apply) {
  $pkgNow = Get-Content $pkgPath -Raw
  foreach ($name in $specs.Keys) {
    if ($pkgNow -notmatch [regex]::Escape($specs[$name].new)) { $failures += "package.json 未包含 $($specs[$name].new)" }
  }
  if ((Get-Content $wsPath -Raw) -notmatch [regex]::Escape($soulNew)) { $failures += "pnpm-workspace.yaml 未指向 $soulNew" }

  foreach ($name in $specs.Keys) {
    $dir = Join-Path $profileFull "node_modules\@void\$name"
    if (-not (Test-Path $dir)) { $failures += "$name 目录不存在"; continue }
    $count = Get-PackageFileCount $dir
    if ($count -ne $expectedCounts[$name]) { $failures += "$name 文件数 $count，期望 $($expectedCounts[$name])" }
  }

  $legion = Join-Path $profileFull "node_modules\@void\void-legion"
  if (-not (Test-Path (Join-Path $legion "lib\source-panel.js"))) { $failures += "legion 缺 lib\source-panel.js" }
  if (Test-Path (Join-Path $legion "lib\source-view.js")) { $failures += "legion 仍带旧的 source-view.js" }
  $suite = Join-Path $profileFull "node_modules\@void\void-entry\lib\client.js"
  if (-not (Select-String -Path $suite -SimpleMatch "军团运行" -Quiet)) { $failures += "entry client 不含「军团运行」页签" }
  $soulPolicy = Join-Path $profileFull "node_modules\@void\void-soul\lib\entry-policy.js"
  if (-not (Select-String -Path $soulPolicy -SimpleMatch "SELF_GOVERNED_NAMES" -Quiet)) { $failures += "soul 不含 B1 的 legion_policy 例外" }
  if (-not (Test-Path (Join-Path $profileFull "node_modules\@larksuiteoapi\node-sdk\package.json"))) { $failures += "缺少 @larksuiteoapi/node-sdk（legion 的飞书源依赖）" }

  if ($failures.Count -eq 0) {
    Write-Host "  全部通过：soul 49 / entry 48 / legion 73 文件，入口与依赖齐全。" -ForegroundColor Green
    Write-Host "  lock 大小：$((Get-Item (Join-Path $profileFull 'pnpm-lock.yaml')).Length) B" -ForegroundColor DarkGray
  } else {
    foreach ($f in $failures) { Write-Host "  [!] $f" -ForegroundColor Yellow }
  }
} else {
  Write-Action "将核对：soul 49 / entry 48 / legion 73 文件；source-panel.js 在、source-view.js 不在；entry 含四页签；soul 含 legion_policy 例外；lark SDK 已装"
}

# ── 6. 写回滚说明并收尾 ────────────────────────────────────────────────────
Write-Step "6/6 收尾"
if ($Apply) {
  $rollback = @"
回滚步骤（2026-11-06 B8 升级）
备份目录：$backup
profile：$profileFull

1) 完全退出 DeepSeek Harness。
2) 把当前三个包目录移走（不要直接删）：
   Move-Item "$profileFull\node_modules\@void\void-soul"   "$root\.tmp\upgrade-failed-$stamp\void-soul"
   Move-Item "$profileFull\node_modules\@void\void-entry"  "$root\.tmp\upgrade-failed-$stamp\void-entry"
   Move-Item "$profileFull\node_modules\@void\void-legion" "$root\.tmp\upgrade-failed-$stamp\void-legion"
3) 把备份里的 profile 四件套与三个包目录复制回去：
   Copy-Item "$backup\package.json"        "$profileFull\package.json" -Force
   Copy-Item "$backup\pnpm-workspace.yaml" "$profileFull\pnpm-workspace.yaml" -Force
   Copy-Item "$backup\pnpm-lock.yaml"      "$profileFull\pnpm-lock.yaml" -Force
   Copy-Item "$backup\cordis.patch.yml"    "$profileFull\cordis.patch.yml" -Force
   Copy-Item "$backup\void-soul"   "$profileFull\node_modules\@void\void-soul"   -Recurse -Force
   Copy-Item "$backup\void-entry"  "$profileFull\node_modules\@void\void-entry"  -Recurse -Force
   Copy-Item "$backup\void-legion" "$profileFull\node_modules\@void\void-legion" -Recurse -Force
4) 重新打开 DeepSeek Harness。

说明：升级时如果没有旧名单，会新写 $policyPath；旧代码不认识这个文件，回滚后留着无害。
"@
  Set-Content (Join-Path $backup "ROLLBACK.txt") $rollback -Encoding utf8
  Write-Host "  回滚说明：$backup\ROLLBACK.txt"
  if ($failures.Count -eq 0) {
    Write-Host ""
    Write-Host "升级完成。请重新打开 DeepSeek Harness 桌面应用，然后告诉助手“已重开，验证升级”。" -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "pnpm install 成功，但核对有未通过项；先别当成功，按上面清单排查或回滚。" -ForegroundColor Yellow
    exit 2
  }
} else {
  Write-Action "dry-run 结束；确认无误后关掉桌面应用，再执行：pwsh -File scripts/upgrade-desktop-profile.ps1 -Apply"
}
