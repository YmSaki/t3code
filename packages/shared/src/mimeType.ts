export const GENERIC_MIME_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  // macOS and Windows label TypeScript `.ts` files as MPEG transport streams, which browsers can't play.
  "video/mp2t",
  "video/vnd.dlna.mpeg-tts",
]);
