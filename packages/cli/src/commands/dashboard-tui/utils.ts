export function isTTYAvailable(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}
