# Génère le .zip de soumission Chrome Web Store à la racine du projet.
# Inclut UNIQUEMENT les fichiers de l'extension (pas webapp/, .git, store/, docs).
# Les chemins internes utilisent des slashes '/' (compatibilité Web Store).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root    = Split-Path -Parent $PSScriptRoot           # racine du projet
$version = (Get-Content (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json).version
$zip     = Join-Path $root "manga-translator-$version.zip"

# Liste des fichiers à inclure (relatifs à la racine).
$files = @(
  'manifest.json',
  'background.js',
  'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
)
# Dossiers entiers à inclure.
foreach ($dir in @('sidepanel', 'lib')) {
  Get-ChildItem (Join-Path $root $dir) -Recurse -File | ForEach-Object {
    $files += $_.FullName.Substring($root.Length + 1).Replace('\', '/')
  }
}

if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($rel in $files) {
    $full = Join-Path $root ($rel -replace '/', '\')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $archive, $full, $rel, 'Optimal') | Out-Null
  }
} finally { $archive.Dispose() }

Write-Host "OK -> $zip ($($files.Count) fichiers)"
