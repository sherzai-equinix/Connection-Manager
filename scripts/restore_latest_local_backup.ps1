$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

$backupRoot = Join-Path $repoRoot "backups\local"
if (-not (Test-Path $backupRoot)) {
    throw "Kein lokaler Backup-Ordner gefunden."
}

$latestBackup = Get-ChildItem $backupRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1
if (-not $latestBackup) {
    throw "Keine lokalen Backups gefunden."
}

foreach ($item in @(".env", "connection_manager.db")) {
    $sourcePath = Join-Path $latestBackup.FullName $item
    if (Test-Path $sourcePath) {
        Copy-Item $sourcePath -Destination (Join-Path $repoRoot $item) -Force
    }
}

Write-Host "Lokale Dateien aus Backup wiederhergestellt: $($latestBackup.FullName)"