[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $SourcePath,

    [string] $DestinationPath
)

if (-not $DestinationPath) {
    $toolDirectory = Split-Path -Parent $PSCommandPath
    $DestinationPath = Join-Path (Split-Path -Parent $toolDirectory) 'canlii-courts.js'
}

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$source = [System.IO.File]::ReadAllText($resolvedSource)
$objectMatch = [regex]::Match(
    $source,
    'export const A2AJ_CANLII_COURT_ROUTES:[^=]+?=\s*\{(?<body>.*?)\r?\n\};',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
)
if (-not $objectMatch.Success) {
    throw 'A2AJ_CANLII_COURT_ROUTES was not found in the selected source file.'
}

$entryPattern = '^\s*(?:"(?<quoted>[A-Z0-9-]+)"|(?<bare>[A-Z0-9-]+)):\s*"(?<route>[^"]+)",'
$entries = [regex]::Matches(
    $objectMatch.Groups['body'].Value,
    $entryPattern,
    [System.Text.RegularExpressions.RegexOptions]::Multiline
)
if ($entries.Count -lt 300) {
    throw "Only $($entries.Count) court routes were parsed; refusing to replace the known-complete table."
}

$sourceHash = (Get-FileHash -LiteralPath $resolvedSource -Algorithm SHA256).Hash.ToLowerInvariant()
$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add("'use strict';")
$lines.Add('')
$lines.Add('// Generated verbatim from Beaver/A2AJ_CANLII_COURT_ROUTES by tools/sync-canlii-courts.ps1.')
$lines.Add("// Source SHA-256: $sourceHash")
$lines.Add('(function exposeCanliiCourts(global) {')
$lines.Add('  const routes = Object.freeze({')
foreach ($entry in $entries) {
    $key = if ($entry.Groups['quoted'].Success) { $entry.Groups['quoted'].Value } else { $entry.Groups['bare'].Value }
    $route = $entry.Groups['route'].Value
    $lines.Add("    '$key': '$route',")
}
$lines.Add('  });')
$lines.Add('')
$lines.Add('  // CanLII uses French database and neutral-citation codes for these bilingual courts.')
$lines.Add('  const frenchRoutes = Object.freeze({')
$lines.Add("    CSC: 'ca/csc',")
$lines.Add("    CAF: 'ca/caf',")
$lines.Add("    CF: 'ca/cf',")
$lines.Add("    CCI: 'ca/cci',")
$lines.Add("    CACM: 'ca/cacm'")
$lines.Add('  });')
$lines.Add('')
$lines.Add("  const api = Object.freeze({ routes, frenchRoutes, sourceSha256: '$sourceHash' });")
$lines.Add('  global.LegalPinpointerCanliiCourts = api;')
$lines.Add("  if (typeof module !== 'undefined' && module.exports) module.exports = api;")
$lines.Add('})(globalThis);')

$resolvedDestination = [System.IO.Path]::GetFullPath($DestinationPath)
[System.IO.File]::WriteAllLines($resolvedDestination, $lines, [System.Text.UTF8Encoding]::new($false))
Write-Host "Wrote $($entries.Count) exact routes to $resolvedDestination"
