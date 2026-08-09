/* FNXC:IssueImportAttachments 2026-08-09-14:09: This browser-safe predicate only identifies possible image markup; URL policy and attachment caps remain server-side. */
export function containsIssueImageMarkup(text: string): boolean {
  return text.includes("![") || /<img\b/iu.test(text);
}
export const PER_BODY_MAX_CHARS = 256_000;
export const TRANSPORT_MAX_CHARS = 1_000_000;
