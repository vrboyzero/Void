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

# 逐个 link Void 包（绝对路径），bundle 会被自动识别并加入 bundles
# 注意：只装 4 个独立插件包；组合 bundle @void/void 依赖这些包（workspace:*），
# 本地 link 时其内部依赖无法解析，故本地开发直接装独立包即可（等价于组合层）。
$packages = @("void-memory", "void-tools", "void-legion", "void-channel-feishu")
foreach ($p in $packages) {
  dsh plugin --profile $Profile add (Join-Path $root "packages\$p") | Out-Null
}

Write-Host ""
Write-Host "=== profile bundles ==="
(Get-Content "$env:DSH_HOME\profiles\$Profile\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles

Write-Host "=== dump-config（void 层）==="
dsh --profile $Profile --dump-config | Select-String -Pattern "# ==|void-" | Select-Object -First 30
