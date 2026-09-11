#requires -Version 5.1
<#
.SYNOPSIS
  Verify Authenticode signatures on Arlet Windows artifacts.
.DESCRIPTION
  Arlet-native implementation; workflow inspired by Zinnia. Checks every
  .exe/.msi under the target release dir (plus extras) for a valid signature
  matching the expected publisher subject.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetReleaseDir,
  [string[]]$ExtraFiles = @()
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:SKIP_WIN_CODESIGN -eq '1') { Write-Host 'SKIP_WIN_CODESIGN=1; skipping Authenticode verification.'; exit 0 }
if ($env:OS -ne 'Windows_NT') { throw 'Authenticode verification must run on Windows.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER is required for Authenticode verification.' }
if ([string]::IsNullOrWhiteSpace($env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN)) { throw 'AZURE_ARTIFACT_SIGNING_PUBLISHER_DN is required for full Authenticode identity verification.' }

$releaseDir = (Resolve-Path -LiteralPath $TargetReleaseDir).Path
$files = @(Get-ChildItem -LiteralPath $releaseDir -File -Filter '*.exe')
$bundleDir = Join-Path $releaseDir 'bundle'
if (Test-Path -LiteralPath $bundleDir) {
  $files += Get-ChildItem -LiteralPath $bundleDir -File -Recurse | Where-Object {
    $_.Extension.ToLowerInvariant() -in @('.exe', '.msi')
  }
}
foreach ($extra in $ExtraFiles) {
  if ($extra -and (Test-Path -LiteralPath $extra)) {
    $files += Get-Item -LiteralPath $extra
  }
}
$files = @($files | Sort-Object FullName -Unique)
if (-not $files.Count) { throw "No Windows runtime or installer artifacts were found under $releaseDir" }

$expectedPublisher = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
$expectedDn = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()
foreach ($file in $files) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode signature is not valid for $($file.FullName): $($signature.Status)"
  }
  $subject = $signature.SignerCertificate.Subject
  if ($subject -ne $expectedDn -and $subject -notmatch [regex]::Escape($expectedPublisher)) {
    throw "Unexpected signature subject for $($file.FullName): $subject"
  }
  Write-Host "Authenticode OK: $($file.FullName)"
}
Write-Host "Authenticode verification passed for $($files.Count) file(s)."
