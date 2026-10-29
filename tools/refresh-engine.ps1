# Builds the browser engine (engine-src) into legal-structure.wasm.gz, legal-structure.js and legal-structure.mjs.
# By default it builds the revisions engine-src/Cargo.toml pins, from engine-src/Cargo.lock. -LegalStructurePath and
# -CommonLawCitePath build from local checkouts instead, as [patch] overrides of those pins. Cargo runs from a folder
# outside every checkout, so no Cargo configuration around this one (a parent workspace's) changes what is built.
param(
    [string]$LegalStructurePath,
    [string]$CommonLawCitePath
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $projectRoot 'engine-src\Cargo.toml'
$targetDirectory = Join-Path $projectRoot 'engine-src\target'
$overrides = @()
$localRoots = @()
foreach ($local in @(
        @($LegalStructurePath, 'https://github.com/eliziff/legal-structure-parser.git', @('legal-structure')),
        @($CommonLawCitePath, 'https://github.com/eliziff/common-law-cite.git', @('legal-citations', 'legal-text')))) {
    if (-not $local[0]) { continue }
    $root = (Resolve-Path -LiteralPath $local[0]).Path
    $localRoots += $root
    foreach ($crate in $local[2]) {
        $crateRoot = if ($crate -eq 'legal-structure') { $root } else { Join-Path $root "crates\$crate" }
        if (-not (Test-Path -LiteralPath (Join-Path $crateRoot 'Cargo.toml') -PathType Leaf)) { throw "No $crate Cargo.toml exists at: $crateRoot" }
        $overrides += '--config'
        $overrides += "patch.'$($local[1])'.$crate.path='$($crateRoot.Replace('\', '/'))'"
    }
}
# A pinned build reads only the committed lock file; a local one resolves the checkouts' own versions.
[string[]]$locked = if ($overrides.Count) { @() } else { @('--locked') }

$home_ = [Environment]::GetFolderPath('UserProfile')
$cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $home_ '.cargo' }
# Keep personal and toolchain paths out of panic locations compiled into the binary: a local checkout's folder becomes
# /src, Cargo's (its git checkouts among them) /cargo, the home folder /home. The last matching prefix applies, so the
# broadest comes first. The encoded form allows spaces.
$pairs = @(, @($home_, '/home')) + @(, @($cargoHome, '/cargo')) + @($localRoots | ForEach-Object { , @((Split-Path -Parent $_), '/src') })
$remaps = foreach ($pair in $pairs) {
    "--remap-path-prefix=$($pair[0])=$($pair[1])"
    "--remap-path-prefix=$($pair[0].Replace('\', '/'))=$($pair[1])"
}
$previousRustFlags = $env:CARGO_ENCODED_RUSTFLAGS
$env:CARGO_ENCODED_RUSTFLAGS = $remaps -join [char]0x1f
Push-Location ([IO.Path]::GetTempPath())
# Windows PowerShell treats Cargo's ordinary stderr progress as a terminating error under Stop. Read the actual exit
# status, then restore strict file ops.
$ErrorActionPreference = 'Continue'
try {
    cargo build --manifest-path $manifest --target wasm32-unknown-unknown --release --jobs 1 --target-dir $targetDirectory @locked @overrides
    $buildCode = $LASTEXITCODE
    if ($buildCode -eq 0) {
        $metadataJson = & cargo metadata --manifest-path $manifest --format-version 1 @locked @overrides
        $metadataCode = $LASTEXITCODE
    }
} finally {
    Pop-Location
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
$package = Join-Path ([IO.Path]::GetTempPath()) ("legal-pinpointer-engine-" + [guid]::NewGuid().ToString('N'))
try {
    & wasm-bindgen --target no-modules --no-modules-global legalStructureInit --no-typescript --out-name legal-structure --out-dir $package $builtWasm
    if ($LASTEXITCODE -ne 0) { throw 'Browser engine binding generation failed.' }
    # The extension ships the engine gzip-compressed and inflates it with DecompressionStream.
    $wasm = Join-Path $package 'legal-structure_bg.wasm'
    $bytes = [IO.File]::ReadAllBytes($wasm)
    $text = [Text.Encoding]::ASCII.GetString($bytes)
    foreach ($private in @($home_) + @($localRoots | ForEach-Object { Split-Path -Parent $_ })) {
        if ($text.Contains($private) -or $text.Contains($private.Replace("\", "/"))) { throw "The engine still contains $private; check the path remapping." }
    }
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
    if (Test-Path -LiteralPath $package) { Remove-Item -LiteralPath $package -Recurse -Force }
}
