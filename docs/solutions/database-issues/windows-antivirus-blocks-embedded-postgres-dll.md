---
category: database-issues
module: embedded-postgres
tags: [windows, antivirus, postgresql, embedded-postgres]
problem_type: installation
applies_when: Windows startup reports `could not load library` with `unknown error 4551` for an embedded PostgreSQL DLL.
---

# Windows antivirus blocks an embedded PostgreSQL DLL

## Symptom

Fusion fails during embedded PostgreSQL initialization with a message such as `could not load library .../lib/dict_snowball.dll: unknown error 4551`.

## Cause

Windows error 4551 is `ERROR_VIRUS_DELETED`: Windows Defender or another antivirus product quarantined a DLL from Fusion's host-local embedded PostgreSQL runtime payload. See [issue #3489](https://github.com/Runfusion/Fusion/issues/3489).

Earlier versions trusted a marker that identified the source payload but did not verify the copied destination. A quarantined destination DLL could therefore remain cached across every restart.

## Remedy

1. In **Windows Security**, open **Virus & threat protection** → **Manage settings** → **Exclusions** and add `%USERPROFILE%\.fusion\embedded-postgres`.
2. Restore the quarantined DLL from **Protection history**.
3. Restart Fusion.

Fusion verifies the runtime-bin payload on startup. Once the exclusion permits the copy, Fusion automatically re-materializes missing or truncated files and clears the recovery diagnosis.
