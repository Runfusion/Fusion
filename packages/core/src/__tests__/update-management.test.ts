import { describe, expect, it } from "vitest";
import { resolveUpdatesExternallyManaged } from "../config/update-management.js";

const resolve = (value: string | undefined) =>
  resolveUpdatesExternallyManaged(value === undefined ? {} : { FUSION_UPDATES_EXTERNALLY_MANAGED: value });

describe("resolveUpdatesExternallyManaged", () => {
  it.each(["1", "true", "TRUE", " yes ", "on"])("accepts %j", (value) => {
    expect(resolve(value)).toBe(true);
  });

  it.each([undefined, "", "0", "false", "no", "off", "enabled"])("rejects %j", (value) => {
    expect(resolve(value)).toBe(false);
  });
});
