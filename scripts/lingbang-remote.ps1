<#
.SYNOPSIS
  检查 Tailscale，生成灵榜私网接入配置；默认只预览，不改 Serve 或凭据。
.DESCRIPTION
  Enable/Disable 只有同时指定 -Apply 才修改当前设备的 Serve 路径。
  启用前确认：loopback MCP 无匿名回退、拒绝陌生 Origin、指定 token 可认证。
  拒绝覆盖既有 Serve 配置，不修改 ACL、不启用 Funnel、不写 .env。
  失败时保留现有设置；启用前快照存入仓库 .tmp/lingbang-remote/。
.EXAMPLE
  pwsh -File scripts/lingbang-remote.ps1
.EXAMPLE
  pwsh -File scripts/lingbang-remote.ps1 -Action Enable -TokenEnv LINGBANG_OFFICE_TOKEN
.EXAMPLE
  pwsh -File scripts/lingbang-remote.ps1 -Action Enable -TokenEnv LINGBANG_OFFICE_TOKEN -Apply
.EXAMPLE
  pwsh -File scripts/lingbang-remote.ps1 -Action Disable -Apply
#>
[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Enable', 'Disable')][string]$Action = 'Inspect',
  [ValidateRange(1, 65535)][int]$DshPort = 3080,
  [ValidateRange(1, 65535)][int]$HttpsPort = 443,
  [ValidatePattern('^/[A-Za-z0-9_/-]+$')][string]$McpPath = '/mcp/dsh-agent-control',
  [ValidatePattern('^[A-Za-z_][A-Za-z0-9_]*$')][string]$TokenEnv = 'LINGBANG_OFFICE_TOKEN',
  [ValidatePattern('^[A-Za-z0-9_-]{1,32}$')][string]$ServerName = 'office-dsh',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
if ($McpPath.EndsWith('/') -or $McpPath.Contains('//') -or $McpPath -eq '/') { throw 'McpPath 必须是单一 MCP 端点路径。' }
$command = Get-Command tailscale -ErrorAction SilentlyContinue
$tailscaleExe = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles 'Tailscale/tailscale.exe' }
if (-not (Test-Path -LiteralPath $tailscaleExe)) { throw '未找到 Tailscale CLI，请先安装或把它加入 PATH。' }

function Read-TailscaleJson([string[]]$Arguments) {
  $output = & $tailscaleExe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Tailscale 命令失败：$($Arguments -join ' ')" }
  return ($output -join "`n" | ConvertFrom-Json -AsHashtable)
}

$state = Read-TailscaleJson @('status', '--json')
if ($state.BackendState -ne 'Running' -or -not $state.Self.Online) { throw 'Tailscale 尚未登录或本机离线。' }
$dnsName = ([string]$state.Self.DNSName).TrimEnd('.')
if (-not $dnsName.EndsWith('.ts.net')) { throw '设备没有可用的 ts.net MagicDNS 名称。' }
$suffix = if ($HttpsPort -eq 443) { '' } else { ":$HttpsPort" }
$remoteUrl = "https://${dnsName}${suffix}${McpPath}"
$upstream = "http://127.0.0.1:${DshPort}${McpPath}"
$serve = Read-TailscaleJson @('serve', 'status', '--json')
$enableArgs = @('serve', '--bg', "--https=$HttpsPort", "--set-path=$McpPath", $upstream)
$disableArgs = @('serve', "--https=$HttpsPort", "--set-path=$McpPath", 'off')

Write-Host "Tailscale：在线；已有 Serve 配置：$($serve.Count -gt 0)"
Write-Host "目标：$remoteUrl"
Write-Host "启用：tailscale $($enableArgs -join ' ')"
Write-Host "回滚：tailscale $($disableArgs -join ' ')"
Write-Host @"

# 调用端 Codex：只引用环境变量；按连接分别授权
[mcp_servers.$ServerName]
url = "$remoteUrl"
bearer_token_env_var = "$TokenEnv"
default_tools_approval_mode = "prompt"
tool_timeout_sec = 45

# 调用端 DSH：加入它自己的 cordis.patch.yml；变量须存在于该 DSH 的启动环境
- id: mcp-$ServerName
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    serverName: $ServerName
    url: '$remoteUrl'
    headers: !!js >-
      (() => { const t = process.env.$TokenEnv; if (!t) throw new Error('missing $TokenEnv'); return { Authorization: 'Bearer ' + t }; })()
    toolCallTimeoutMs: 45000
    failOnStartupError: false

网络 grants/ACL：只允许获准的调用端设备访问本机 tcp:$HttpsPort。
网络 ACL 不能限制 URL 路径；启用后要从另一台获准设备确认 /、/api 等路径没有暴露 Web UI。
"@

if (-not $Apply -or $Action -eq 'Inspect') {
  Write-Host '当前为预览：未修改 Serve、ACL、客户端配置或凭据。'
  return
}

if ($Action -eq 'Enable') {
  # 不覆盖别人的服务；同一设备上的 Funnel/root mount 也不能由本脚本暗中继承。
  if ($serve.Count -gt 0) { throw '已有 Serve 配置。请先检查并手工合并；本脚本拒绝覆盖。' }
  $token = [Environment]::GetEnvironmentVariable($TokenEnv, 'Process')
  if ([string]::IsNullOrWhiteSpace($token)) { throw "当前进程缺少 $TokenEnv；仅填写变量名，勿把 token 放进命令参数。" }
  function Get-HttpStatus([hashtable]$Headers) {
    try {
      return [int](Invoke-WebRequest -Uri $upstream -Method Get -Headers $Headers -SkipHttpErrorCheck -TimeoutSec 10).StatusCode
    } catch { throw '无法连接本机 MCP 端点，请确认 DSH 已运行并监听 loopback。' }
  }
  if ((Get-HttpStatus @{}) -ne 401) { throw '本机端点未拒绝匿名访问，停止启用。' }
  if ((Get-HttpStatus @{ Origin = 'https://untrusted.invalid' }) -ne 403) { throw '本机端点缺少预期的 Origin 拒绝，停止启用。' }
  if ((Get-HttpStatus @{ Authorization = "Bearer $token" }) -ne 405) { throw '本机 token 未认证成功，停止启用。' }
  $snapshotDir = Join-Path (Split-Path -Parent $PSScriptRoot) '.tmp/lingbang-remote'
  New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null
  $serve | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $snapshotDir "serve-before-$(Get-Date -Format 'yyyyMMdd-HHmmss-fff').json")
  & $tailscaleExe @enableArgs
} else {
  $web = if ($serve.Web) { $serve.Web["${dnsName}:$HttpsPort"] } else { $null }
  $handler = if ($null -ne $web) { $web.Handlers[$McpPath] } else { $null }
  if ($null -eq $handler -or $handler.Proxy -ne $upstream) { throw '没有找到与本次参数完全一致的路径代理，拒绝移除其他配置。' }
  & $tailscaleExe @disableArgs
}
if ($LASTEXITCODE -ne 0) { throw 'Serve 操作失败；请查看 tailscale serve status，再按上方命令回滚本路径。' }
Write-Host 'Serve 操作完成。请继续从另一台获准设备运行 lingbang-remote-smoke.mjs。'
