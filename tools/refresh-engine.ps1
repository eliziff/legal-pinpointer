param(
    [Parameter(Mandatory = $true)]
    [string]$LegalStructurePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$wrapperSource = Join-Path $projectRoot 'engine-src\src\lib.rs'
$sourceRoot = (Resolve-Path -LiteralPath $LegalStructurePath).Path
$sourceManifest = Join-Path $sourceRoot 'Cargo.toml'

if (-not (Test-Path -LiteralPath $sourceManifest -PathType Leaf)) {
    throw "No legal-structure Cargo.toml exists at: $sourceRoot"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("legal-pinpointer-engine-" + [guid]::NewGuid().ToString('N'))
$temporarySource = Join-Path $temporaryRoot 'src'
New-Item -ItemType Directory -Path $temporarySource | Out-Null

try {
    Copy-Item -LiteralPath $wrapperSource -Destination (Join-Path $temporarySource 'lib.rs')
    $cargoPath = $sourceRoot.Replace('\', '/')
    $manifest = @"
[package]
name = "legal-structure-browser-engine"
version = "0.1.0"
edition = "2021"
publish = false

[lib]
crate-type = ["cdylib"]

[dependencies]
legal-structure = { path = "$cargoPath", features = ["provider-text"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

[profile.release]
codegen-units = 1
lto = true
opt-level = "s"
panic = "abort"
strip = true
"@
    Set-Content -LiteralPath (Join-Path $temporaryRoot 'Cargo.toml') -Value $manifest -Encoding utf8
    cargo build --manifest-path (Join-Path $temporaryRoot 'Cargo.toml') --target wasm32-unknown-unknown --release --offline
    if ($LASTEXITCODE -ne 0) { throw "The browser engine build failed with exit code $LASTEXITCODE." }

    $builtWasm = Join-Path $temporaryRoot 'target\wasm32-unknown-unknown\release\legal_structure_browser_engine.wasm'
    Copy-Item -LiteralPath $builtWasm -Destination (Join-Path $projectRoot 'legal-structure.wasm') -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $projectRoot 'legal-structure.wasm')).Hash.ToLowerInvariant()
    Write-Host "Refreshed legal-structure.wasm ($hash)"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
