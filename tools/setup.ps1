[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('Agent','Tavern')][string]$Mode,
  [string]$PrivateDirectory,
  [ValidateRange(1, 65535)][int]$Port = 4318,
  [string[]]$AllowedOrigins = @(),
  [string]$PairingCode,
  [string]$TavernOrigin,
  [switch]$OpenTavern
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$rootParent = Split-Path -Parent $root
$rootLeaf = Split-Path -Leaf $root
if ([string]::IsNullOrWhiteSpace($rootLeaf)) { $rootLeaf = 'XLDB' }
if ([string]::IsNullOrWhiteSpace($PrivateDirectory)) { $PrivateDirectory = Join-Path $rootParent ($rootLeaf + '-private') }

function Write-JsonAtomic([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

& (Join-Path $PSScriptRoot 'install.ps1')

$setupReceiptPath = Join-Path $root '.local\install\setup-receipt.json'
if ($Mode -eq 'Agent') {
  if (-not [string]::IsNullOrWhiteSpace($PairingCode) -or -not [string]::IsNullOrWhiteSpace($TavernOrigin) -or $OpenTavern) {
    throw 'Agent 模式不使用 PairingCode、TavernOrigin 或 OpenTavern。'
  }
  $receipt = [ordered]@{
    schemaVersion = 1
    mode = 'Agent'
    root = $root
    status = 'ready'
    checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
    httpStarted = $false
    modelApiConfigured = $false
  }
  Write-JsonAtomic $setupReceiptPath $receipt
  Write-Host 'XLDB Agent 模式已就绪；未启动 HTTP 服务，也未配置或请求模型 API。'
  return
}

$startParameters = @{
  PrivateDirectory = $PrivateDirectory
  Port = $Port
  AllowedOrigins = $AllowedOrigins
}
if (-not [string]::IsNullOrWhiteSpace($PairingCode)) { $startParameters.PairingCode = $PairingCode }
if (-not [string]::IsNullOrWhiteSpace($TavernOrigin)) { $startParameters.TavernOrigin = $TavernOrigin }
if ($OpenTavern) { $startParameters.OpenTavern = $true }
& (Join-Path $PSScriptRoot 'start.ps1') @startParameters
$receipt = [ordered]@{
  schemaVersion = 1
  mode = 'Tavern'
  root = $root
  privateDirectory = [IO.Path]::GetFullPath($PrivateDirectory)
  port = $Port
  status = 'ready'
  checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
  httpStarted = $true
}
Write-JsonAtomic $setupReceiptPath $receipt
Write-Host 'XLDB Tavern 模式已就绪。'
