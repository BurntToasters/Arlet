#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FilePath,
  # Tauri's signCommand signs during bundling. The post-build safety pass can
  # use this switch, but only a fully verified signature is skippable.
  [switch]$SkipIfSigned
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Keep direct PowerShell invocation behind the same release policy as the
# Node build driver. This prevents an unsigned stable artifact if this helper
# is called outside tauri-windows-build.js.
$policy = Join-Path $PSScriptRoot 'release-policy.cjs'
& node $policy
if ($LASTEXITCODE -ne 0) {
  throw 'Stable release policy rejected the Windows signing environment.'
}

if ($env:SKIP_WIN_CODESIGN -eq '1') {
  Write-Host "SKIP_WIN_CODESIGN=1; leaving Windows artifact unsigned: $FilePath"
  exit 0
}
if ($env:OS -ne 'Windows_NT') {
  throw 'Azure Artifact Signing must run on Windows.'
}

$required = @(
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_ARTIFACT_SIGNING_ENDPOINT',
  'AZURE_ARTIFACT_SIGNING_ACCOUNT',
  'AZURE_ARTIFACT_SIGNING_PROFILE',
  'AZURE_ARTIFACT_SIGNING_PUBLISHER',
  'AZURE_ARTIFACT_SIGNING_PUBLISHER_DN'
)
$missing = @($required | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_))
  })
if ($missing.Count) {
  throw "Missing Azure Artifact Signing environment variables: $($missing -join ', ')"
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "Windows artifact was not found: $FilePath"
}
$resolved = (Resolve-Path -LiteralPath $FilePath).Path
$expectedPublisher = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER.Trim()
$expectedSubject = $env:AZURE_ARTIFACT_SIGNING_PUBLISHER_DN.Trim()

. (Join-Path $PSScriptRoot 'artifact-signing-tools.ps1')
Import-BundledPowerShellSecurityModule

function Assert-ArtifactAuthenticodeSignature {
  param(
    [Parameter(Mandatory = $true)]$Signature,
    [Parameter(Mandatory = $true)][string]$SignedPath
  )

  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode verification failed for ${SignedPath}: $($Signature.Status) $($Signature.StatusMessage)"
  }
  if (-not $Signature.SignerCertificate) {
    throw "Missing signer certificate: $SignedPath"
  }

  # Both checks are intentional: SimpleName catches the human-facing
  # publisher identity, while Subject catches certificate substitutions.
  $publisher = $Signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
    $false
  )
  if ($publisher -ne $expectedPublisher) {
    throw "Unexpected Authenticode publisher for $SignedPath. Expected '$expectedPublisher', got '$publisher'."
  }
  $subject = $Signature.SignerCertificate.Subject.Trim()
  if ($subject -ne $expectedSubject) {
    throw "Unexpected Authenticode Subject for $SignedPath. Expected '$expectedSubject', got '$subject'."
  }
  if (-not $Signature.TimeStamperCertificate) {
    throw "Missing RFC3161 timestamp: $SignedPath"
  }
}

if ($SkipIfSigned) {
  $existing = Get-AuthenticodeSignature -LiteralPath $resolved
  try {
    Assert-ArtifactAuthenticodeSignature $existing $resolved
    Write-Host "Already signed with the expected identity and RFC3161 timestamp; skipping: $resolved"
    exit 0
  } catch {
    Write-Host "Existing signature does not satisfy the Arlet signing policy; signing again: $resolved"
  }
}

$tools = Get-ArtifactSigningTools
$metadataPath = Join-Path ([IO.Path]::GetTempPath()) "arlet-signing-$PID-$([Guid]::NewGuid().ToString('N')).json"
try {
  $metadata = @{
    Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT.Trim()
    CodeSigningAccountName = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT.Trim()
    CertificateProfileName = $env:AZURE_ARTIFACT_SIGNING_PROFILE.Trim()
    ExcludeCredentials = @(
      'ManagedIdentityCredential',
      'WorkloadIdentityCredential',
      'SharedTokenCacheCredential',
      'VisualStudioCredential',
      'VisualStudioCodeCredential',
      'AzureCliCredential',
      'AzurePowerShellCredential',
      'AzureDeveloperCliCredential',
      'InteractiveBrowserCredential'
    )
  } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText($metadataPath, $metadata, (New-Object Text.UTF8Encoding($false)))

  Write-Host "Artifact Signing: $resolved"
  & $tools.SignToolPath sign /v /debug /fd SHA256 /tr 'http://timestamp.acs.microsoft.com' /td SHA256 /dlib $tools.DlibPath /dmdf $metadataPath $resolved
  if ($LASTEXITCODE -ne 0) {
    throw "SignTool failed with exit code $LASTEXITCODE for $resolved"
  }
} finally {
  Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolved
Assert-ArtifactAuthenticodeSignature $signature $resolved
Write-Host "Verified Authenticode signature: $expectedSubject ($resolved)"
