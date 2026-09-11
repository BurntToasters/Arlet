#requires -Version 5.1
<#
.SYNOPSIS
  Sign one Windows file via Azure Artifact Signing (Public Trust).
.DESCRIPTION
  Arlet-native implementation; workflow inspired by Zinnia. Arlet ships only
  NSIS installers/portable executables, so sparse-MSIX handling is omitted.
  With -SkipIfSigned, files that already carry a valid signature are left
  alone: tauri.conf.json signCommand signs binaries during bundling, so the
  post-build pass must not stack a second signature on them.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  [switch]$SkipIfSigned
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:SKIP_WIN_CODESIGN -eq '1') {
  Write-Host "SKIP_WIN_CODESIGN=1; leaving Windows artifact unsigned: $FilePath"
  exit 0
}
if ($env:OS -ne 'Windows_NT') { throw 'Azure Artifact Signing must run on Windows.' }

$resolved = (Resolve-Path -LiteralPath $FilePath).Path
if ($SkipIfSigned) {
  $existing = Get-AuthenticodeSignature -LiteralPath $resolved
  if ($existing.Status -eq [System.Management.Automation.SignatureStatus]::Valid) {
    Write-Host "Already signed; skipping: $resolved"
    exit 0
  }
}

$required = @('AZURE_CLIENT_ID','AZURE_TENANT_ID','AZURE_CLIENT_SECRET','AZURE_ARTIFACT_SIGNING_ENDPOINT','AZURE_ARTIFACT_SIGNING_ACCOUNT','AZURE_ARTIFACT_SIGNING_PROFILE','AZURE_ARTIFACT_SIGNING_PUBLISHER','AZURE_ARTIFACT_SIGNING_PUBLISHER_DN')
$missing = @($required | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_)) })
if ($missing.Count) { throw "Missing Azure Artifact Signing environment variables: $($missing -join ', ')" }

$resolved = (Resolve-Path -LiteralPath $FilePath).Path
$signtool = (Get-Command signtool.exe -ErrorAction Stop).Source
$dlib = Get-ChildItem -Path ${env:ProgramFiles} -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $dlib) { throw 'Azure.CodeSigning.Dlib.dll not found. Run npm run setup:win:artifact-signing once as Administrator.' }

$metadataPath = Join-Path ([IO.Path]::GetTempPath()) "arlet-signing-$PID-$([Guid]::NewGuid().ToString('N')).json"
try {
  $metadata = @{
    Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.Trim()
    CodeSigningAccountName = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT.Trim()
    CertificateProfileName = $env:AZURE_ARTIFACT_SIGNING_PROFILE.Trim()
    ExcludeCredentials = @('ManagedIdentityCredential','WorkloadIdentityCredential','SharedTokenCacheCredential','VisualStudioCredential','VisualStudioCodeCredential','AzureCliCredential','AzurePowerShellCredential','AzureDeveloperCliCredential','InteractiveBrowserCredential')
  } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($metadataPath, $metadata, (New-Object Text.UTF8Encoding($false)))
  Write-Host "Artifact Signing: $resolved"
  & $signtool sign /v /debug /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib.FullName /dmdf $metadataPath $resolved
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE for $resolved" }
} finally {
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
}
