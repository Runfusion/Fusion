import type { CustomProvider } from "../types.js";

function slugifyProviderName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function customProviderRegistryKey(provider: CustomProvider, allProviders: CustomProvider[]): string {
  const base = slugifyProviderName(provider.name) || provider.id;
  let count = 0;

  for (const current of allProviders) {
    const currentBase = slugifyProviderName(current.name) || current.id;
    if (currentBase === base) {
      count += 1;
    }
    if (current.id === provider.id) {
      break;
    }
  }

  return count <= 1 ? base : `${base}-${count}`;
}
