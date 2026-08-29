function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(text: string, secrets: string[]): string {
  if (!text) return text;
  const unique = [...new Set(secrets.filter((secret) => secret && secret.length > 0))].sort((a, b) => b.length - a.length);
  return unique.reduce((acc, secret) => acc.replace(new RegExp(escapeRegExp(secret), "g"), "***"), text);
}
