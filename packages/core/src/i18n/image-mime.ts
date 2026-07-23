export type DetectedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/*
FNXC:ImageAttachments 2026-06-28-00:00:
FN-7211: AI image-block media_type must match the real image bytes. Attachment storage keeps the extension-derived mimeType for display, but Anthropic rejects mismatched pairings such as stored image/webp over PNG bytes, so model-bound image blocks sniff bytes at build time.
*/
export function detectImageMimeFromBytes(bytes: Buffer | Uint8Array): DetectedImageMime | null {
  if (bytes.length >= 8
      && bytes[0] === 0x89
      && bytes[1] === 0x50
      && bytes[2] === 0x4e
      && bytes[3] === 0x47
      && bytes[4] === 0x0d
      && bytes[5] === 0x0a
      && bytes[6] === 0x1a
      && bytes[7] === 0x0a) {
    return "image/png";
  }

  if (bytes.length >= 3
      && bytes[0] === 0xff
      && bytes[1] === 0xd8
      && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (bytes.length >= 6
      && bytes[0] === 0x47
      && bytes[1] === 0x49
      && bytes[2] === 0x46
      && bytes[3] === 0x38
      && (bytes[4] === 0x37 || bytes[4] === 0x39)
      && bytes[5] === 0x61) {
    return "image/gif";
  }

  if (bytes.length >= 12
      && bytes[0] === 0x52
      && bytes[1] === 0x49
      && bytes[2] === 0x46
      && bytes[3] === 0x46
      && bytes[8] === 0x57
      && bytes[9] === 0x45
      && bytes[10] === 0x42
      && bytes[11] === 0x50) {
    return "image/webp";
  }

  return null;
}
