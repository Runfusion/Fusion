const REPORTER_FLAG = /^(?:--reporter|-r)(?:=|$)/;

/**
 * FNXC:TestInfrastructure 2026-07-24-10:30:
 * CI shard commands append Vitest JSON reporter and package-relative output
 * flags after each package's `test` script. Desktop's wrapper must preserve
 * those caller arguments so its timing data reaches the Full Suite artifact;
 * use dot only for interactive/default invocations that selected no reporter.
 */
export function buildDesktopVitestArgs(callerArgs: readonly string[]): string[] {
  const args = ["run", "--silent=passed-only", ...callerArgs];
  return callerArgs.some((arg) => REPORTER_FLAG.test(arg)) ? args : [...args, "--reporter=dot"];
}
