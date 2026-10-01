import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { externalSessionIdentifier, type ExternalSessionPrincipal } from "@fusion/core";

const credentialSchema = z.object({
  projectId: externalSessionIdentifier,
  hostId: externalSessionIdentifier,
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ExternalSessionCollectorCredential = z.infer<typeof credentialSchema>;

/**
 * FNXC:ExternalSessions 2026-09-17-04:00:
 * Each secret identifies exactly one host/project pair. Store SHA-256 digests, not bearer tokens.
 * Invalid or ambiguous configuration fails closed; no dashboard cookie/query-token fallback exists.
 */
export function parseExternalSessionCollectorCredentials(value: unknown): ExternalSessionCollectorCredential[] | null {
  const parsed = z.array(credentialSchema).min(1).max(128).safeParse(value);
  if (!parsed.success) return null;
  const hashes = new Set<string>();
  for (const credential of parsed.data) {
    if (hashes.has(credential.tokenSha256)) return null;
    hashes.add(credential.tokenSha256);
  }
  return parsed.data;
}

export function authenticateExternalSessionCollector(authorization: string | undefined, credentials: readonly ExternalSessionCollectorCredential[]): ExternalSessionPrincipal | null {
  if (!authorization?.startsWith("Bearer ") || authorization.length > 512 || authorization.length <= 7) return null;
  const digest = createHash("sha256").update(authorization.slice(7)).digest();
  let principal: ExternalSessionPrincipal | null = null;
  for (const credential of credentials) {
    if (timingSafeEqual(digest, Buffer.from(credential.tokenSha256, "hex"))) {
      principal = { projectId: credential.projectId, hostId: credential.hostId };
    }
  }
  return principal;
}
