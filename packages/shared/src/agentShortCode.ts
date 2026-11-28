const KNOWN_PROVIDER_SHORT_CODES: Readonly<Record<string, string>> = {
  codex: "cx",
  claudeagent: "cl",
  claude: "cl",
  cursor: "cu",
  opencode: "oc",
  antigravity: "ag",
  pi: "pi",
};

export function getAgentShortCode(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const known = KNOWN_PROVIDER_SHORT_CODES[normalized];
  if (known !== undefined) {
    return known;
  }

  const alphanumeric = normalized.replace(/[^a-z0-9]/g, "");
  if (alphanumeric.length >= 2) {
    return alphanumeric.slice(0, 2);
  }
  if (alphanumeric.length === 1) {
    return `${alphanumeric}x`;
  }
  return "uk";
}
