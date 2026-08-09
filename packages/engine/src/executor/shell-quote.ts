/**
 * FNXC:CodeOrganization 2026-08-03-13:35:
 * POSIX single-quote shell arg helper peeled from TaskExecutor (U4).
 */
export function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
