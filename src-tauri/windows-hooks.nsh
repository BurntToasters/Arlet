!include LogicLib.nsh

!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 == ""
    MessageBox MB_ICONSTOP|MB_OK "Arlet requires Windows 10 version 22H2 (build 19045) or newer."
    Abort
  ${EndIf}
  IntCmp $0 19045 arlet_windows_supported arlet_windows_unsupported arlet_windows_supported
  arlet_windows_unsupported:
    MessageBox MB_ICONSTOP|MB_OK "Arlet requires Windows 10 version 22H2 (build 19045) or newer."
    Abort
  arlet_windows_supported:
!macroend
