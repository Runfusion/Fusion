// U7 SECURITY tests for the path jail (Risk S3). Each `it` is a security
// assertion against real temp dirs + real symlinks. Do NOT weaken these to go
// green — if one fails, the JAIL is wrong, not the test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  assertPathWithinCwd,
  openWithinCwd,
  isSecretPath,
  isGitInternal,
  PathJailError,
} from "../path-jail.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  // realpath the temp roots up front — macOS /var → /private/var symlinking
  // would otherwise look like an escape.
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "acp-jail-cwd-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "acp-jail-out-")));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

describe("assertPathWithinCwd", () => {
  it("accepts an existing file inside cwd and returns its real path", async () => {
    await writeFile(path.join(cwd, "a.txt"), "hi", "utf8");
    const resolved = await assertPathWithinCwd("a.txt", cwd);
    expect(resolved).toBe(path.join(cwd, "a.txt"));
  });

  it("accepts a nested file inside cwd", async () => {
    await mkdir(path.join(cwd, "sub"), { recursive: true });
    await writeFile(path.join(cwd, "sub", "b.txt"), "hi", "utf8");
    const resolved = await assertPathWithinCwd("sub/b.txt", cwd);
    expect(resolved).toBe(path.join(cwd, "sub", "b.txt"));
  });

  it("accepts a not-yet-existing file when its parent is inside cwd", async () => {
    const resolved = await assertPathWithinCwd("new-file.txt", cwd);
    expect(resolved).toBe(path.join(cwd, "new-file.txt"));
  });

  it("rejects a lexical `../` escape with path_outside_cwd", async () => {
    await expect(assertPathWithinCwd("../../etc/passwd", cwd)).rejects.toMatchObject({
      code: "path_outside_cwd",
    });
  });

  it("rejects an absolute path outside cwd", async () => {
    await writeFile(path.join(outside, "secret.txt"), "x", "utf8");
    await expect(
      assertPathWithinCwd(path.join(outside, "secret.txt"), cwd),
    ).rejects.toBeInstanceOf(PathJailError);
  });

  it("rejects a NUL byte in the path with invalid_path", async () => {
    await expect(assertPathWithinCwd("a\0b.txt", cwd)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("rejects an empty path with invalid_path", async () => {
    await expect(assertPathWithinCwd("", cwd)).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  // --- THE symlink-escape test (Risk S3 threat 2) ---
  it("rejects a symlink INSIDE cwd that points OUTSIDE (existing target)", async () => {
    const secret = path.join(outside, "passwd");
    await writeFile(secret, "root:x:0:0", "utf8");
    // link inside cwd -> file outside cwd
    await symlink(secret, path.join(cwd, "link-to-secret"));
    await expect(
      assertPathWithinCwd("link-to-secret", cwd),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });

  it("rejects a symlinked DIRECTORY inside cwd pointing out, even for a child path", async () => {
    await mkdir(path.join(outside, "etc"), { recursive: true });
    await writeFile(path.join(outside, "etc", "passwd"), "x", "utf8");
    await symlink(path.join(outside, "etc"), path.join(cwd, "etc-link"));
    await expect(
      assertPathWithinCwd("etc-link/passwd", cwd),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });

  it("rejects a DANGLING symlink final component for a write target", async () => {
    // symlink inside cwd to a non-existent file outside → realpath of target
    // fails, parent (cwd) is fine, but lstat shows the final component IS a
    // symlink → reject (it would otherwise be followed out on open).
    await symlink(path.join(outside, "nope.txt"), path.join(cwd, "dangling"));
    await expect(
      assertPathWithinCwd("dangling", cwd),
    ).rejects.toMatchObject({ code: "path_outside_cwd" });
  });
});

describe("openWithinCwd (TOCTOU defense)", () => {
  it("opens a regular file inside cwd", async () => {
    const p = path.join(cwd, "ok.txt");
    await writeFile(p, "content", "utf8");
    const handle = await openWithinCwd(p, cwd, fsConstants.O_RDONLY);
    const data = await handle.readFile({ encoding: "utf8" });
    await handle.close();
    expect(data).toBe("content");
  });

  it("refuses to follow a symlink final component (O_NOFOLLOW)", async () => {
    const target = path.join(cwd, "real.txt");
    await writeFile(target, "real", "utf8");
    const link = path.join(cwd, "link.txt");
    await symlink(target, link);
    // Even though both link and target are inside cwd, O_NOFOLLOW must refuse to
    // open through the symlink — closing the swap-a-symlink TOCTOU window.
    await expect(
      openWithinCwd(link, cwd, fsConstants.O_RDONLY),
    ).rejects.toBeTruthy();
  });
});

describe("deny-list predicates", () => {
  it("flags secret basenames", () => {
    for (const f of [
      ".env",
      ".env.local",
      ".env.production",
      "server.pem",
      "tls.key",
      ".npmrc",
      ".netrc",
      "id_rsa",
      "id_ed25519.pub",
      "credentials",
      // FIX 6: expanded secret deny-list.
      ".git-credentials",
      "server.p12",
      "cert.pfx",
      "release.keystore",
      "app.jks",
      ".dockercfg",
      ".pgpass",
      ".htpasswd",
    ]) {
      expect(isSecretPath(path.join(cwd, f))).toBe(true);
    }
  });

  it("does not flag ordinary files as secret", () => {
    for (const f of ["index.ts", "README.md", "envoy.json", "keyboard.txt"]) {
      expect(isSecretPath(path.join(cwd, f))).toBe(false);
    }
  });

  it("flags any path under a .git/ dir", () => {
    expect(isGitInternal(path.join(cwd, ".git", "config"))).toBe(true);
    expect(isGitInternal(path.join(cwd, ".git", "hooks", "pre-commit"))).toBe(true);
    expect(isGitInternal(path.join(cwd, "src", "app.ts"))).toBe(false);
    expect(isGitInternal(path.join(cwd, "gitignore.txt"))).toBe(false);
  });
});
