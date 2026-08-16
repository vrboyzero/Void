# Clean-profile smoke for the merged @void/void-memory tarball.
#
# Steps:
#   1. install dsh-headless into a fresh DSH_HOME
#   2. allow better-sqlite3 install scripts in the profile pnpm workspace
#   3. install the @void/void-memory tarball
#   4. dump the composed config
#   5. if -ApiKey is provided, ask the model to call memory_search
#
# All child output goes to %TEMP%\dsh-void-smoke.log; the script prints the tail.
param(
  [string]$Profile = "smoke",
  [string]$DshHome = "",
  [string]$MemoryTarball = "",
  [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if ([string]::IsNullOrWhiteSpace($DshHome)) {
  $DshHome = Join-Path $env:TEMP "dsh-void-smoke"
}
if ([string]::IsNullOrWhiteSpace($MemoryTarball)) {
  $MemoryTarball = Join-Path $root "dist\void-void-memory-0.1.0.tgz"
}
if (-not (Test-Path $MemoryTarball)) {
  throw "Memory tarball not found: $MemoryTarball (run .\scripts\pack-all.ps1 first)"
}

$log = Join-Path $env:TEMP "dsh-void-smoke.log"
Remove-Item -Force $log -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $DshHome -ErrorAction SilentlyContinue
$env:DSH_HOME = $DshHome

Write-Host "[1/5] add @deepseek-ai/dsh-headless@0.1.0-rc.6"
dsh plugin --profile $Profile add @deepseek-ai/dsh-headless@0.1.0-rc.6 *>> $log
if ($LASTEXITCODE -ne 0) {
  Get-Content $log -Tail 120
  throw "headless install failed (log: $log)"
}

Write-Host "[2/5] allow better-sqlite3 build scripts"
$profileDir = Join-Path $DshHome "profiles\$Profile"
$workspaceYaml = Join-Path $profileDir "pnpm-workspace.yaml"
$workspaceText = Get-Content -Raw -Path $workspaceYaml
if ($workspaceText -notmatch 'onlyBuiltDependencies') {
  Add-Content -Path $workspaceYaml -Value "`nonlyBuiltDependencies:`n  - better-sqlite3`n"
}

Write-Host "[3/5] add $MemoryTarball"
dsh plugin --profile $Profile add $MemoryTarball *>> $log
if ($LASTEXITCODE -ne 0) {
  Get-Content $log -Tail 120
  throw "void-memory tarball install failed (log: $log)"
}

Write-Host "[4/5] dump composed config"
dsh --profile $Profile --dump-config *>> $log
if ($LASTEXITCODE -ne 0) {
  Get-Content $log -Tail 120
  throw "dump-config failed (log: $log)"
}

if (-not [string]::IsNullOrWhiteSpace($ApiKey)) {
  Write-Host "[5/5] model smoke (call memory_search)"
  $env:DEEPSEEK_API_KEY = $ApiKey
  dsh --profile $Profile "请调用 memory_search 搜索 hello，然后报告结果" *>> $log
  $runCode = $LASTEXITCODE
  Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
  if ($runCode -ne 0) {
    Get-Content $log -Tail 160
    throw "model smoke failed (log: $log)"
  }
} else {
  Write-Host "[5/5] skipped model smoke (no -ApiKey provided)"
}

Write-Host ""
Write-Host "=== tail of $log ==="
Get-Content $log -Tail 120
Write-Host ""
Write-Host "full log: $log"
