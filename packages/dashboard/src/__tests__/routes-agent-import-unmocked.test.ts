import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../server.js";
import { request } from "../test-request.js";

class MockStore extends EventEmitter {
  constructor(private readonly rootDir: string) {
    super();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getFusionDir(): string {
    return join(this.rootDir, ".fusion");
  }

  getDatabase() {
    return {
      exec() {},
      prepare() {
        return {
          run() {
            return { changes: 0 };
          },
          get() {
            return undefined;
          },
          all() {
            return [];
          },
        };
      },
    };
  }
}

function createTarFixture(archivePath: string, cwd: string, rootEntry: string): void {
  execSync(
    `tar czf ${JSON.stringify(archivePath)} -C ${JSON.stringify(cwd)} ${JSON.stringify(rootEntry)}`,
  );
}

async function postImport(app: Parameters<typeof request>[0], body: unknown) {
  return request(app, "POST", "/api/agents/import", JSON.stringify(body), {
    "content-type": "application/json",
  });
}

describe("POST /api/agents/import (unmocked archive parsing)", () => {
  let rootDir: string;
  let app: ReturnType<typeof createServer>;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "fn-agent-import-unmocked-"));
    mkdirSync(join(rootDir, ".fusion"), { recursive: true });
    app = createServer(new MockStore(rootDir) as any);
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("imports agents from a real .tgz archive source", async () => {
    const packageDir = join(rootDir, "company-package");
    mkdirSync(join(packageDir, "agents", "ceo"), { recursive: true });
    mkdirSync(join(packageDir, "skills", "review"), { recursive: true });
    writeFileSync(join(packageDir, "COMPANY.md"), "---\nname: Archive Company\nslug: archive-company\n---\n", "utf-8");
    writeFileSync(join(packageDir, "agents", "ceo", "AGENTS.md"), "---\nname: Archive CEO\nrole: reviewer\n---\nLead reviews.\n", "utf-8");
    writeFileSync(join(packageDir, "skills", "review", "SKILL.md"), "---\nname: Review\ndescription: Review skill\n---\n# Review\n", "utf-8");

    const archivePath = join(rootDir, "company.tgz");
    createTarFixture(archivePath, rootDir, "company-package");

    const response = await postImport(app, { source: archivePath });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      companyName: "Archive Company",
      companySlug: "archive-company",
      skipped: [],
      errors: [],
      skillsCount: 1,
      created: [
        {
          name: "Archive CEO",
        },
      ],
    });
  });
});
