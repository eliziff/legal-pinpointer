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
$targetDirectory = Join-Path $projectRoot 'engine-src\target'
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
legal-structure = { path = "$cargoPath", default-features = false, features = ["canada", "journal", "provider-text", "citator"] }
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
    # Windows PowerShell treats Cargo's ordinary stderr progress as a terminating
    # error under Stop. Read the actual exit status, then restore strict file ops.
    $ErrorActionPreference = 'Continue'
    # Keep personal and toolchain paths out of panic locations compiled into the binary: the
    # sources' folder becomes /src and Cargo's becomes /cargo. The encoded form allows spaces.
    $previousRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
    $home_ = [Environment]::GetFolderPath('UserProfile')
    $sourceParent = Split-Path -Parent $sourceRoot
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $home_ '.cargo' }
    $remaps = foreach ($pair in @(@($home_, '/home'), @($cargoHome, '/cargo'), @($sourceParent, '/src'))) {
        "--remap-path-prefix=$($pair[0])=$($pair[1])"
        "--remap-path-prefix=$($pair[0].Replace('\', '/'))=$($pair[1])"
    }
    $env:CARGO_ENCODED_RUSTFLAGS = $remaps -join [char]0x1f
    try {
        cargo build --manifest-path (Join-Path $temporaryRoot 'Cargo.toml') --target wasm32-unknown-unknown --release --offline --jobs 1 --target-dir $targetDirectory
        $buildCode = $LASTEXITCODE
        if ($buildCode -eq 0) {
            $metadataJson = & cargo metadata --manifest-path (Join-Path $temporaryRoot 'Cargo.toml') --format-version 1 --offline
            $metadataCode = $LASTEXITCODE
        }
    } finally {
        $env:CARGO_ENCODED_RUSTFLAGS = $previousRustFlags
        $ErrorActionPreference = 'Stop'
    }
    if ($buildCode -ne 0) { throw "The browser engine build failed with exit code $buildCode." }
    if ($metadataCode -ne 0) { throw 'Cannot read the browser engine dependency versions.' }
    $metadata = $metadataJson | ConvertFrom-Json
    $citationRoot = Split-Path -Parent ($metadata.packages | Where-Object name -eq 'legal-citations').manifest_path
    foreach ($notice in @('LICENSE', 'NOTICE')) {
        Copy-Item -LiteralPath (Join-Path $citationRoot $notice) -Destination (Join-Path $projectRoot ("legal-citations-" + $notice + '.txt')) -Force
    }
    $bindgenVersion = ($metadata.packages | Where-Object name -eq 'wasm-bindgen').version
    $installedBindgen = (& wasm-bindgen --version) -replace '^wasm-bindgen ', ''
    if ($LASTEXITCODE -ne 0 -or $installedBindgen -ne $bindgenVersion) {
        throw "Install wasm-bindgen-cli $bindgenVersion to match the browser engine."
    }
    $builtWasm = Join-Path $targetDirectory 'wasm32-unknown-unknown\release\legal_structure_browser_engine.wasm'
    $package = Join-Path $temporaryRoot 'pkg'
    & wasm-bindgen --target no-modules --no-modules-global legalStructureInit --no-typescript --out-name legal-structure --out-dir $package $builtWasm
    if ($LASTEXITCODE -ne 0) { throw 'Browser engine binding generation failed.' }
    # The extension ships the engine gzip-compressed and inflates it with DecompressionStream.
    $wasm = Join-Path $package 'legal-structure_bg.wasm'
    $bytes = [IO.File]::ReadAllBytes($wasm)
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    foreach ($private in @($home_, $sourceParent)) { if ($text.Contains($private) -or $text.Contains($private.Replace("\", "/"))) { throw "The engine still contains $private; check the path remapping." } }
    $target = [IO.File]::Create((Join-Path $projectRoot 'legal-structure.wasm.gz'))
    try {
        $gzip = New-Object IO.Compression.GZipStream($target, [IO.Compression.CompressionLevel]::Optimal)
        $gzip.Write($bytes, 0, $bytes.Length)
        $gzip.Dispose()
    } finally { $target.Dispose() }
    Copy-Item -LiteralPath (Join-Path $package 'legal-structure.js') -Destination (Join-Path $projectRoot 'legal-structure.js') -Force
    $modulePackage = Join-Path $package 'esm'
    & wasm-bindgen --target web --no-typescript --out-name legal-structure --out-dir $modulePackage $builtWasm
    if ($LASTEXITCODE -ne 0) { throw 'Browser engine module binding generation failed.' }
    Copy-Item -LiteralPath (Join-Path $modulePackage 'legal-structure.js') -Destination (Join-Path $projectRoot 'legal-structure.mjs') -Force
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $wasm).Hash.ToLowerInvariant()
    Write-Host "Refreshed legal-structure.wasm.gz (inflated sha256 $hash)"
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedTemporaryRoot = (Resolve-Path -LiteralPath $temporaryRoot).Path
        $temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTemporaryRoot.StartsWith($temporaryParent, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Unsafe temporary build path: $resolvedTemporaryRoot"
        }
        Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
    }
}
