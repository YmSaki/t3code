export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const characters = Array.from(trimmed);
  if (characters.length <= maxLength) {
    return trimmed;
  }

  return `${characters.slice(0, maxLength).join("")}...`;
}

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}
