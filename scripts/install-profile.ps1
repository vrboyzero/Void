# 把 Void 源码包（绝对路径 link）+ headless 装进一个 dsh profile（本地开发/验证）
# 说明：dsh plugin add <绝对路径> 会自动识别 dsh.bundle 并加进 profile 的 bundles，无需手动改。
param(
  [string]$Profile = "void",
  [string]$DshHome = ""
)
$root = Split-Path -Parent $PSScriptRoot
if ($DshHome) { $env:DSH_HOME = $DshHome }

# headless 务必显式 rc.6（勿用 latest，见 FAQ）
dsh plugin --profile $Profile add @deepseek-ai/dsh-headless@0.1.0-rc.6

# 干净 profile 安装 @void/void-memory 前，允许 better-sqlite3 的 install script；
# 否则 dsh 转发的 pnpm 会忽略 native build，导致 "Could not locate the bindings file"。
$profileDir = Join-Path $env:DSH_HOME "profiles\$Profile"
$workspaceYaml = Join-Path $profileDir "pnpm-workspace.yaml"
if (Test-Path $workspaceYaml) {
  $workspaceText = Get-Content -Raw -Path $workspaceYaml
  if ($workspaceText -notmatch 'onlyBuiltDependencies') {
    Add-Content -Path $workspaceYaml -Value "`nonlyBuiltDependencies:`n  - better-sqlite3`n"
  }
}

# 逐个 link Void 包（绝对路径），bundle 会被自动识别并加入 bundles
# 顺序：soul 在前（memory / legion 依赖它），entry 提供界面（业务视图与通知栏都在它这），
# feishu 是可选渠道。本地 link 时组合包 @void/void 的内部依赖无法解析，故本地开发装独立包。
$packages = @("void-soul", "void-memory", "void-tools", "void-legion", "void-entry", "void-channel-feishu")
foreach ($p in $packages) {
  dsh plugin --profile $Profile add (Join-Path $root "packages\$p") | Out-Null
}

Write-Host ""
Write-Host "=== profile bundles ==="
(Get-Content "$env:DSH_HOME\profiles\$Profile\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles

Write-Host "=== dump-config（void 层）==="
dsh --profile $Profile --dump-config | Select-String -Pattern "# ==|void-" | Select-Object -First 30

Write-Host ""
Write-Host "提示：dsh --profile $Profile 不会替你设 DSH_PROFILE。跑 Web / headless 前还要："
Write-Host "  `$env:DSH_PROFILE = `"$Profile`"      # 数据根 = `$env:DSH_HOME\void-data\$Profile"
Write-Host "只给 DSH_HOME 时插件照样加载，业务视图会回 404「无法确定档案位置」（见 Void使用指南.md 2.6）。"
