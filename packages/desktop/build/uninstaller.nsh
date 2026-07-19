; FNXC:WindowsDesktopPackaging 2026-07-18-05:20:
; Operator request: uninstalling Fusion on Windows must also shut down the
; embedded PostgreSQL server and remove Fusion's materialized runtime binaries
; (~\.fusion\embedded-postgres\runtime-bin, recreated on demand). The database
; cluster (~\.fusion\embedded-postgres\default) is USER DATA: interactive
; uninstalls ask before deleting it, silent uninstalls always keep it, and
; auto-update reinstalls (${isUpdated}) touch nothing so updates never kill a
; running server or prompt.
;
; FNXC:WindowsDesktopPackaging 2026-07-18-06:00:
; Review finding: a for /f loop over postmaster.pid ran taskkill on EVERY line
; (line 4 is the TCP port — a plausible PID of some unrelated process). Read
; ONLY the first line, trim CR/LF, and require it to be purely numeric before
; killing anything.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; Read the postmaster PID: first line of postmaster.pid, digits only.
    ClearErrors
    FileOpen $0 "$PROFILE\.fusion\embedded-postgres\default\postmaster.pid" r
    ${ifNot} ${Errors}
      FileRead $0 $1
      FileClose $0
      ; Trim trailing CR/LF.
      loop_trim:
        StrCpy $2 $1 1 -1
        ${if} $2 == "$\r"
          StrCpy $1 $1 -1
          Goto loop_trim
        ${endif}
        ${if} $2 == "$\n"
          StrCpy $1 $1 -1
          Goto loop_trim
        ${endif}
      ; Digits-only guard: reject empty or any non-numeric character.
      StrCpy $3 0
      ${if} $1 == ""
        Goto skip_kill
      ${endif}
      digit_check:
        StrCpy $2 $1 1 $3
        ${if} $2 == ""
          Goto do_kill
        ${endif}
        ${if} $2 < "0"
          Goto skip_kill
        ${endif}
        ${if} $2 > "9"
          Goto skip_kill
        ${endif}
        IntOp $3 $3 + 1
        Goto digit_check
      do_kill:
        nsExec::ExecToLog 'taskkill /PID $1 /F /T'
      skip_kill:
    ${endIf}
    RMDir /r "$PROFILE\.fusion\embedded-postgres\runtime-bin"
    IfSilent +3 0
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the embedded PostgreSQL database (all local Fusion data) at $PROFILE\.fusion\embedded-postgres?" IDNO +2
      RMDir /r "$PROFILE\.fusion\embedded-postgres"
  ${endIf}
!macroend
