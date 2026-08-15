# 打包所有 Void 包 + Star 快照到 dist/（pnpm pack 会把 workspace:* 重写为版本号）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

# 依赖顺序：先快照，再各插件，最后组合 bundle
$packages = @(
  "vendor/star/belldandy-memory",
  "packages/void-memory",
  "packages/void-tools",
  "packages/void-legion",
  "packages/void-channel-feishu",
  "packages/void"
)

foreach ($p in $packages) {
  Write-Host "packing $p ..."
  Push-Location (Join-Path $root $p)
  pnpm pack --pack-destination $dist | Out-Null
  Pop-Location
}

Write-Host "打包完成 -> $dist"
Get-ChildItem $dist -Filter *.tgz | Select-Object -ExpandProperty Name
