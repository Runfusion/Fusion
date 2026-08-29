/**
 * Canonical lucide-react mock helper for dashboard app tests.
 *
 * Add newly used icons here first before creating per-suite lucide export lists.
 */
import React from "react";

type AnyModule = Record<string, unknown>;

function icon(name: string) {
  return function MockIcon(props: Record<string, unknown>) {
    return React.createElement("span", { "data-testid": `icon-${name}`, ...props });
  };
}

export async function createLucideMock(importActual: () => Promise<AnyModule>): Promise<AnyModule> {
  const actual = await importActual();
  return new Proxy({ ...actual }, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (["then", "catch", "finally"].includes(prop)) return undefined;
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      const generated = icon(
        prop.replace(/[A-Z]/g, (m, idx) => (idx === 0 ? m.toLowerCase() : `-${m.toLowerCase()}`)),
      );
      (target as AnyModule)[prop] = generated;
      return generated;
    },
  });
}
