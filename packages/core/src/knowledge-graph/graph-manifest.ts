import { createHash } from "node:crypto";

/** Hash raw file bytes; the manifest must not depend on platform text decoding. */
export const fingerprintContent = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");
