param(
    [string]$Remote = "origin"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

if (-not (Test-Path ".git")) {
    throw "Kein Git-Repository gefunden in $repoRoot"
}

git fetch $Remote --tags

$latestTag = (git tag --list "backup/*" --sort=-creatordate | Select-Object -First 1)
if (-not $latestTag) {
    throw "Kein Backup-Tag gefunden."
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$restoreBranch = "restore/$timestamp"

git switch -c $restoreBranch $latestTag

Write-Host "Restore-Branch erstellt: $restoreBranch"
Write-Host "Quelle: $latestTag"
Write-Host "Wenn du diese Version uebernehmen willst, kannst du spaeter main darauf zuruecksetzen oder mergen."