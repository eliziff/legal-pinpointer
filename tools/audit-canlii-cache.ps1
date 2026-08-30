param(
    [Parameter(Mandatory = $true)]
    [string]$CachePath,
    [Parameter(Mandatory = $true)]
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
$htmlRoot = Join-Path (Resolve-Path -LiteralPath $CachePath).Path 'html'
if (-not (Test-Path -LiteralPath $htmlRoot -PathType Container)) {
    throw "The cache has no html directory: $htmlRoot"
}

$files = @(Get-ChildItem -LiteralPath $htmlRoot -File -Filter '*.html' | Sort-Object Name)
$report = [ordered]@{
    files = $files.Count
    cases = 0
    legislation = 0
    secondary = 0
    caseFilesWithParagraphAnchors = 0
    caseFilesWithExactPageMarkers = 0
    legislationFilesWithProvisionAnchors = 0
    filesWithoutExpectedNativeStructure = @()
}

for ($index = 0; $index -lt $files.Count; $index += 1) {
    $file = $files[$index]
    $html = [System.IO.File]::ReadAllText($file.FullName)
    $typeMatch = [regex]::Match($html, '<meta[^>]+name=["'']lbh-type["''][^>]+content=["'']([^"'']+)', 'IgnoreCase')
    $type = if ($typeMatch.Success) { $typeMatch.Groups[1].Value.ToLowerInvariant() } else { '' }
    $paragraphs = [regex]::Matches($html, '(?:name|id)=["'']par(?:ag)?\d+["'']', 'IgnoreCase').Count
    $provisions = [regex]::Matches($html, '(?:name|id)=["''](?:sec|art|rule)\d+', 'IgnoreCase').Count
    $pages = [regex]::Matches($html, '\[page\s+\d+\]', 'IgnoreCase').Count

    if ($type -eq 'case') {
        $report.cases += 1
        if ($paragraphs -gt 0) { $report.caseFilesWithParagraphAnchors += 1 }
        if ($pages -ge 3) { $report.caseFilesWithExactPageMarkers += 1 }
        if ($paragraphs -eq 0 -and $pages -lt 3) { $report.filesWithoutExpectedNativeStructure += $file.Name }
    } elseif ($type -match 'legislation|statute|regulation|law') {
        $report.legislation += 1
        if ($provisions -gt 0) { $report.legislationFilesWithProvisionAnchors += 1 }
        if ($provisions -eq 0) { $report.filesWithoutExpectedNativeStructure += $file.Name }
    } else {
        $report.secondary += 1
    }

    if ((($index + 1) % 50) -eq 0 -or ($index + 1) -eq $files.Count) {
        $report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ReportPath -Encoding utf8
        Write-Host ("Audited {0}/{1} CanLII pages" -f ($index + 1), $files.Count)
    }
}

$report | ConvertTo-Json -Depth 4
