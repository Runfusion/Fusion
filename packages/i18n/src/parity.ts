const PLURAL_SUFFIX_PATTERN = /_(zero|one|two|few|many|other)$/;

export type CatalogValue = string | number | boolean | null | undefined | CatalogObject | CatalogValue[];
export type CatalogObject = { [key: string]: CatalogValue };

export type NamespaceCatalogs = Record<string, CatalogObject | undefined>;

export type ParityViolationKind = "absent" | "orphan";

export interface ParityViolation {
  locale: string;
  namespace: string;
  kind: ParityViolationKind;
  key: string;
}

export interface FindParityViolationsOptions {
  locale: string;
}

interface FlattenedCatalog {
  keys: Set<string>;
  displayKeysByNormalizedKey: Map<string, Set<string>>;
}

function isRecord(value: CatalogValue): value is CatalogObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePluralKey(key: string): string {
  return key.replace(PLURAL_SUFFIX_PATTERN, "");
}

function normalizeKeyPath(keyPath: string): string {
  return keyPath
    .split(".")
    .map((segment) => normalizePluralKey(segment))
    .join(".");
}

function addDisplayKey(target: Map<string, Set<string>>, normalizedKey: string, keyPath: string) {
  const keys = target.get(normalizedKey) ?? new Set<string>();
  keys.add(keyPath);
  target.set(normalizedKey, keys);
}

function flattenCatalog(catalog: CatalogObject | undefined, prefix = ""): FlattenedCatalog {
  const keys = new Set<string>();
  const displayKeysByNormalizedKey = new Map<string, Set<string>>();

  if (!catalog) {
    return { keys, displayKeysByNormalizedKey };
  }

  for (const [key, value] of Object.entries(catalog)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value === undefined || value === null) {
      continue;
    }
    if (isRecord(value)) {
      const nested = flattenCatalog(value, keyPath);
      for (const nestedKey of nested.keys) {
        keys.add(nestedKey);
      }
      for (const [normalizedKey, displayKeys] of nested.displayKeysByNormalizedKey) {
        for (const displayKey of displayKeys) {
          addDisplayKey(displayKeysByNormalizedKey, normalizedKey, displayKey);
        }
      }
      continue;
    }

    const normalizedKey = normalizeKeyPath(keyPath);
    keys.add(normalizedKey);
    addDisplayKey(displayKeysByNormalizedKey, normalizedKey, keyPath);
  }

  return { keys, displayKeysByNormalizedKey };
}

function representativeKey(catalog: FlattenedCatalog, normalizedKey: string) {
  return [...(catalog.displayKeysByNormalizedKey.get(normalizedKey) ?? [normalizedKey])].sort()[0] ?? normalizedKey;
}

/**
 * FNXC:i18n-ParityGate 2026-06-20-00:00:
 * Fusion intentionally keeps untranslated secondary-locale entries as empty strings so runtime fallback can use `en` without blocking incomplete translation work.
 * The status gate therefore compares catalog key structure only: missing keys and stale orphan keys fail, while present empty values never fail.
 */
export function findParityViolations(
  enCatalogs: NamespaceCatalogs,
  localeCatalogs: NamespaceCatalogs,
  options: FindParityViolationsOptions,
): ParityViolation[] {
  const namespaces = [...new Set([...Object.keys(enCatalogs), ...Object.keys(localeCatalogs)])].sort();
  const violations: ParityViolation[] = [];

  for (const namespace of namespaces) {
    const en = flattenCatalog(enCatalogs[namespace]);
    const locale = flattenCatalog(localeCatalogs[namespace]);

    for (const key of [...en.keys].sort()) {
      if (!locale.keys.has(key)) {
        violations.push({
          locale: options.locale,
          namespace,
          kind: "absent",
          key: representativeKey(en, key),
        });
      }
    }

    for (const key of [...locale.keys].sort()) {
      if (!en.keys.has(key)) {
        violations.push({
          locale: options.locale,
          namespace,
          kind: "orphan",
          key: representativeKey(locale, key),
        });
      }
    }
  }

  return violations;
}
