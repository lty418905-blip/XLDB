[CmdletBinding()]
param([ValidateSet('Agent')][string]$Mode = 'Agent')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install-agent-model.ps1')
& (Join-Path $PSScriptRoot 'install.ps1')
Write-Host 'XLDB Agent installed. Create .local/agent/retrieval-api.txt and fill embedding/reranker API URLs, keys and models following INSTALL_AGENT.md.'
Write-Host 'Then follow .agents/skills/xldb-agent/SKILL.md for companion or roleplay.'
