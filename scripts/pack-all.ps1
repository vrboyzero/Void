# 打包所有 Void 包到 dist/（pnpm pack 会把 workspace:* 重写为版本号）
# @void/void-memory 已按方案 B 内嵌 Star 快照，无需再单独打包快照包。
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force $dist | Out-Null

# 清掉上一轮 tarball，避免旧两包方案的 star 快照包残留并误导安装。
Get-ChildItem $dist -Filter '*.tgz' | Remove-Item -Force

# 依赖顺序：先基础插件，再组合 bundle
$packages = @(
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
