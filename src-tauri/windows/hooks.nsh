; Explorer context-menu verbs for Duckweed (per-user, no admin required).
; Default install: "Open Duckweed in new tab" only. "New window" is opt-in
; from Settings after install.
;
; Also refreshes shell icons after install/update. Windows caches the exe's
; icon aggressively; without SHChangeNotify, desktop/Start/taskbar can keep
; showing a previous icon until reboot or a manual cache clear.

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

  ; Re-write existing shortcuts so their IconLocation points at the new binary
  ; (index 0). CreateShortCut updates the .lnk without changing the target.
  IfFileExists "$DESKTOP\Duckweed.lnk" 0 duckweed_skip_desktop_icon
    CreateShortCut "$DESKTOP\Duckweed.lnk" "$INSTDIR\duckweed.exe" "" "$INSTDIR\duckweed.exe" 0
  duckweed_skip_desktop_icon:
  IfFileExists "$SMPROGRAMS\Duckweed.lnk" 0 duckweed_skip_start_icon
    CreateShortCut "$SMPROGRAMS\Duckweed.lnk" "$INSTDIR\duckweed.exe" "" "$INSTDIR\duckweed.exe" 0
  duckweed_skip_start_icon:

  ; Tell Explorer the binary (and file associations) changed so it reloads icons.
  ; SHCNE_UPDATEITEM (0x1000) + SHCNF_PATHW|SHCNF_FLUSHNOWAIT (0x3005)
  System::Call 'shell32::SHChangeNotify(i 0x1000, i 0x3005, w "$INSTDIR\duckweed.exe", i 0)'
  ; SHCNE_ASSOCCHANGED (0x08000000) + SHCNF_IDLIST (0x0000)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\DuckweedTab"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\DuckweedWindow"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\DuckweedTab"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\DuckweedWindow"
  DeleteRegKey HKCU "Software\dev.slop.duckweed\ExplorerIntegration"
!macroend
