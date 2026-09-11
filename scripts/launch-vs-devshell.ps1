#requires -Version 5.1
<#
.SYNOPSIS
  Launch a Visual Studio developer shell for Arlet Windows builds.
.DESCRIPTION
  Arlet-native implementation; workflow inspired by Zinnia. Locates the VS
  developer shell via vswhere and invokes it for the requested architecture.
#>
[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')]
  [string]$Arch = 'x64'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-VsDevShell {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vswhere)) {
    throw 'vswhere.exe not found. Install Visual Studio 2022 with the Desktop C++ workload.'
  }
  $install = & $vswhere -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ([string]::IsNullOrWhiteSpace($install)) {
    throw 'No Visual Studio installation with C++ tools was found.'
  }
  $launcher = Join-Path $install 'Common7\Tools\Launch-VsDevShell.ps1'
  if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launch-VsDevShell.ps1 not found under $install"
  }
  return $launcher
}

$launcher = Find-VsDevShell
Write-Host "Launching VS developer environment: $launcher ($Arch)"
if ($Arch -eq 'arm64') {
  & $launcher -SkipAutomaticLocation -Arch arm64 -HostArch amd64
} else {
  & $launcher -SkipAutomaticLocation
}
