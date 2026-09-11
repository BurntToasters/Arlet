#requires -Version 5.1
<#
.SYNOPSIS
  Install Microsoft Artifact Signing Client Tools (one-time, elevated).
.DESCRIPTION
  Arlet-native implementation; workflow inspired by Zinnia. Prefers winget,
  falls back to the official Microsoft MSI after verifying its signature.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Artifact Signing Client Tools setup must run on Windows.' }

try {
  $signtool = Get-Command signtool.exe -ErrorAction Stop
  Write-Host 'Artifact Signing Client Tools appear to be installed.'
  Write-Host "SignTool: $($signtool.Source)"
  exit 0
} catch {
  Write-Host 'Installing official Microsoft Artifact Signing Client Tools...'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Installing Artifact Signing Client Tools requires an elevated PowerShell session. Re-run as Administrator.'
}

$installed = $false
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if ($winget) {
  & $winget.Source install -e --id Microsoft.Azure.ArtifactSigningClientTools --accept-package-agreements --accept-source-agreements --silent
  if ($LASTEXITCODE -eq 0) {
    $installed = $true
  } else {
    Write-Warning "winget failed with exit code $LASTEXITCODE; falling back to Microsoft MSI."
  }
}

if (-not $installed) {
  $msiPath = Join-Path ([IO.Path]::GetTempPath()) "ArtifactSigningClientTools-$PID.msi"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://download.microsoft.com/download/70ad2c3b-761f-4aa9-a9de-e7405aa2b4c1/ArtifactSigningClientTools.msi' -OutFile $msiPath
    $signature = Get-AuthenticodeSignature -LiteralPath $msiPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
      throw "Artifact Signing Client Tools MSI signature is not valid: $($signature.Status)"
    }
    if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(?i)(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
      throw 'Artifact Signing Client Tools MSI is not signed by Microsoft Corporation.'
    }
    Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /qn" -Wait
    $installed = $true
  } finally {
    Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  }
}

Write-Host 'Artifact Signing Client Tools setup complete.'
