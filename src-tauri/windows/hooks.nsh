; Explorer context-menu verbs for Duckweed (per-user, no admin required).
; Default install: "Open Duckweed in new tab" only. "New window" is opt-in
; from Settings after install.

!macro NSIS_HOOK_POSTINSTALL
  ; --- Selected folder ---
  WriteRegStr HKCU "Software\Classes\Directory\shell\DuckweedTab" "" "Open Duckweed in new tab"
  WriteRegStr HKCU "Software\Classes\Directory\shell\DuckweedTab" "Icon" "$INSTDIR\duckweed.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\shell\DuckweedTab\command" "" '"$INSTDIR\duckweed.exe" "duckweed://action/new_tab?path=%1"'

  ; --- Empty space inside a folder (%V is the viewed directory) ---
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\DuckweedTab" "" "Open Duckweed in new tab"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\DuckweedTab" "Icon" "$INSTDIR\duckweed.exe,0"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\DuckweedTab\command" "" '"$INSTDIR\duckweed.exe" "duckweed://action/new_tab?path=%V"'

  ; Remember that defaults were applied so the app does not re-add verbs the
  ; user later turns off. "New window" stays off until Settings enables it.
  WriteRegDWORD HKCU "Software\dev.slop.duckweed\ExplorerIntegration" "DefaultsApplied" 1
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\DuckweedTab"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\DuckweedWindow"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\DuckweedTab"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\DuckweedWindow"
  DeleteRegKey HKCU "Software\dev.slop.duckweed\ExplorerIntegration"
!macroend
