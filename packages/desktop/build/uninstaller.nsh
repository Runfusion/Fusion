; FNXC:WindowsDesktopPackaging 2026-07-18-05:20:
; Operator request: uninstalling Fusion on Windows must also shut down the
; embedded PostgreSQL server and remove Fusion's materialized runtime binaries
; (~\.fusion\embedded-postgres\runtime-bin, recreated on demand). The database
; cluster (~\.fusion\embedded-postgres\default) is USER DATA: interactive
; uninstalls ask before deleting it, silent uninstalls always keep it, and
; auto-update reinstalls (${isUpdated}) touch nothing so updates never kill a
; running server or prompt.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Stop the postmaster recorded in postmaster.pid (best effort; the PID is
    ; the file's first line). usebackq tolerates spaces in the profile path.
    nsExec::ExecToLog 'cmd /c for /f "usebackq" %i in ("$PROFILE\.fusion\embedded-postgres\default\postmaster.pid") do taskkill /PID %i /F /T'
    RMDir /r "$PROFILE\.fusion\embedded-postgres\runtime-bin"
    IfSilent +3 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the embedded PostgreSQL database (all local Fusion data) at $PROFILE\.fusion\embedded-postgres?" IDNO +2
      RMDir /r "$PROFILE\.fusion\embedded-postgres"
  ${endIf}
!macroend
