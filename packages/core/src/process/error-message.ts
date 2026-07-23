/**
 * Narrow an unknown caught error into a string message.
 *
 * Designed to replace the `catch (err: any) { ... err.message ... }` pattern:
 * prefer `catch (err) { toast(getErrorMessage(err)) }` — keeps the binding
 * typed as `unknown` (TS default with useUnknownInCatchVariables) while
 * still producing a readable message.
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
