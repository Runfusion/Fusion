import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchUrl, maskSecret, maySurfaceSecret, secretForDisplay } from "../startup-secret.js";

/*
FNXC:StartupSecretDisplay 2026-10-15-21:25 (RUFU-687):
The dashboard bearer token was printed raw by the `fn serve` / `fn dashboard` startup banner. Under
the watchdog that stdout is appended to a log file, so the credential persisted there and stayed
valid — measured in production as 175 `token=<value>` occurrences in one log, one of them replayed
successfully against POST /api/tasks/:id/bypass-review. These tests pin the sink rule (raw only at an
interactive terminal) and the structural half: no banner call site may interpolate the raw token.
*/

const TOKEN = "tok_0123456789abcdef0123456789abcdef";

describe("maskSecret", () => {
  it("keeps only trailing identity characters", () => {
    expect(maskSecret(TOKEN)).toBe(`****${TOKEN.slice(-4)}`);
    expect(maskSecret("")).toBe("none");
    expect(maskSecret(undefined)).toBe("none");
    expect(maskSecret("ab")).toBe("****");
  });
});

describe("maySurfaceSecret", () => {
  it("permits raw output only for a confirmed interactive terminal", () => {
    expect(maySurfaceSecret(true)).toBe(true);
    expect(maySurfaceSecret(false)).toBe(false);
    // A detached/redirected process reports undefined, not false: same rule, no raw output.
    expect(maySurfaceSecret(undefined)).toBe(false);
  });
});

describe("secretForDisplay", () => {
  it("prints the raw token at a terminal so the operator can use it", () => {
    expect(secretForDisplay(TOKEN, true)).toBe(TOKEN);
  });

  it("never leaks the token on a redirected or piped stream", () => {
    const masked = secretForDisplay(TOKEN, false);
    expect(masked).not.toContain(TOKEN);
    expect(masked).toContain(maskSecret(TOKEN));
    // The banner still has to tell the operator what to do next.
    expect(masked.toLowerCase()).toContain("token");
  });
});

describe("launchUrl", () => {
  it("returns a plain URL when auth is disabled", () => {
    expect(launchUrl("http://localhost:4040", null, true)).toBe("http://localhost:4040");
  });

  it("carries the token only at a terminal", () => {
    expect(launchUrl("http://localhost:4040", TOKEN, true)).toBe(
      `http://localhost:4040/?token=${encodeURIComponent(TOKEN)}`,
    );
  });

  it("masks the query credential on a non-terminal, including its encoded form", () => {
    const masked = launchUrl("http://localhost:4040", TOKEN, false);
    expect(masked).not.toContain(TOKEN);
    expect(masked).not.toContain(encodeURIComponent(TOKEN));
    // The URL must still read like a launch URL, and must still say auth is required.
    expect(masked).toMatch(/^http:\/\/localhost:4040\/\?token=\*\*\*\*[0-9a-f]{4}/);
    expect(masked).toContain("auth-required");
  });

  it("survives a token that needs percent-encoding without truncating it", () => {
    const odd = "tok+with/slash=and space";
    expect(launchUrl("http://h:1", odd, true)).toContain(encodeURIComponent(odd));
    expect(launchUrl("http://h:1", odd, false)).not.toContain(encodeURIComponent(odd));
  });
});

describe("startup banner call sites", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (file: string) => readFileSync(path.join(here, "..", file), "utf8");

  it.each(["serve.ts", "dashboard.ts"])(
    "%s does not interpolate the auth token into a printed string",
    (file) => {
      const source = read(file);
      // Code-construct guard, not prose: the banner may print the token only through
      // startup-secret.ts helpers, which apply the sink rule.
      expect(source).not.toMatch(/\?token=\$\{(?:daemonToken|dashboardAuthToken)\}/);
      expect(source).not.toMatch(/console\.(?:log|error)\([^)]*\$\{(?:daemonToken|dashboardAuthToken)\}/);
    },
  );
});
