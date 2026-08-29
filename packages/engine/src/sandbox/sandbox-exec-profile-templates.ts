export const SBPL_HEADER = `(version 1)
(deny default)`;

export const SBPL_BASE_ALLOW = `
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.api"))
(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
`;

export const SBPL_FILE_READ_BASE = `
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/private/etc/ssl"))
(allow file-read* (literal "/private/etc/resolv.conf"))
(allow file-read* (literal "/private/var/run/resolv.conf"))
(allow file-read* (subpath "/private/var/db/timezone"))
(allow file-read* (literal "/private/etc/hosts"))
(allow file-read* (literal "/private/etc/services"))
(allow file-read* (subpath "/private/var/folders"))
`;

export const SBPL_TMP_WRITE = `
(allow file-write* (subpath "/private/tmp"))
`;

export const SBPL_NETWORK_DENY_ALL = `(deny network*)`;

export const SBPL_NETWORK_ALLOW_OUTBOUND = `
(allow network-outbound)
(allow network-bind (local ip))
(allow system-socket)
(deny network-bind (local ip "*:4040"))
`;
