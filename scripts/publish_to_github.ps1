param(
    [string]$Message,
    [string]$Remote = "origin",
    [string]$Branch = "main",
    [switch]$SkipPush
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

if (-not (Test-Path ".git")) {
    throw "Kein Git-Repository gefunden in $repoRoot"
}

$status = git status --porcelain
if (-not $status) {
    Write-Host "Keine Aenderungen gefunden. Nichts zu committen."
    exit 0
}

$currentBranch = (git branch --show-current).Trim()
if (-not $currentBranch) {
    $currentBranch = $Branch
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupTag = "backup/$currentBranch/$timestamp"
$backupDir = Join-Path $repoRoot "backups\local\$timestamp"

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

foreach ($item in @(".env", "connection_manager.db")) {
    $sourcePath = Join-Path $repoRoot $item
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath -Destination (Join-Path $backupDir $item) -Force
    }
}

$headBeforeCommit = (git rev-parse HEAD).Trim()
git tag $backupTag $headBeforeCommit

git add -A

if (-not $Message) {
    $Message = "Update $timestamp"
}

git commit -m $Message

if ($SkipPush) {
    Write-Host "Commit erstellt, Push uebersprungen."
    Write-Host "Backup-Tag: $backupTag"
    Write-Host "Lokales Backup: $backupDir"
    exit 0
}

git push $Remote $currentBranch
git push $Remote $backupTag

Write-Host "GitHub Update abgeschlossen."
Write-Host "Backup-Tag: $backupTag"
Write-Host "Lokales Backup: $backupDir"