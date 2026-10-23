$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$webDir = Join-Path $PSScriptRoot 'web'
New-Item -ItemType Directory -Force -Path $webDir | Out-Null
$files = @('index.html', 'storage.js', 'backup.js', 'cloud-sync.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'sw.js')
foreach ($file in $files) {
  Copy-Item -LiteralPath (Join-Path $appRoot $file) -Destination (Join-Path $webDir $file) -Force
}
Write-Output "Copied HITIT web app to $webDir"

