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

; An update runs the old uninstaller with /UPDATE ($UpdateMode = 1); the
; startup entry stays then, since the updated app keeps the same path.
!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Arlet"
  ${EndIf}
!macroend
