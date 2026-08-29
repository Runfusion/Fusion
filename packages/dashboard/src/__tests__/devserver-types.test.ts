// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MAX_LOG_ENTRIES,
  createDevServerId,
  type DevServerConfig,
  type DevServerLogEntry,
  type DevServerSession,
  type DevServerSessionMap,
  type DevServerStatus,
} from "../devserver-types.js";

describe("devserver-types", () => {
  it("createDevServerId returns a branded string", () => {
    const id = createDevServerId("server-1");

    expect(id).toBe("server-1");
    expect(typeof id).toBe("string");
  });

  it("constructs a complete DevServerSession shape", () => {
    const config: DevServerConfig = {
      id: createDevServerId("s-1"),
      name: "App",
      command: "npm run dev",
      cwd: "/repo",
      env: { NODE_ENV: "development" },
      autoStart: true,
    };

    const session: DevServerSession = {
      config,
      status: "running",
      runtime: {
        pid: 1234,
        startedAt: new Date().toISOString(),
        exitCode: 0,
        previewUrl: "http://localhost:3000",
      },
      previewUrl: "http://localhost:3000",
      logHistory: [
        {
          timestamp: new Date().toISOString(),
          stream: "stdout",
          text: "ready",
        },
      ],
    };

    expect(session.config.name).toBe("App");
    expect(session.status).toBe("running");
    expect(session.runtime?.pid).toBe(1234);
    expect(session.logHistory[0]?.stream).toBe("stdout");
  });

  it("DevServerSessionMap behaves as a map of id -> session", () => {
    const map: DevServerSessionMap = new Map();
    const id = createDevServerId("server-a");

    map.set(id, {
      config: {
        id,
        name: "A",
        command: "vite",
        cwd: "/repo",
      },
      status: "stopped",
      logHistory: [],
    });

    expect(map.get(id)?.config.command).toBe("vite");
    expect(Array.from(map.keys())).toEqual(["server-a"]);
  });

  it("MAX_LOG_ENTRIES is 500", () => {
    expect(MAX_LOG_ENTRIES).toBe(500);
  });

  it("all DevServerStatus values are assignable", () => {
    const statuses: DevServerStatus[] = ["stopped", "starting", "running", "failed", "stopping"];

    expect(statuses).toHaveLength(5);
    expect(statuses.includes("failed")).toBe(true);
  });

  it("DevServerConfig supports optional fields omitted and included", () => {
    const minimal: DevServerConfig = {
      id: createDevServerId("minimal"),
      name: "Minimal",
      command: "npm run dev",
      cwd: "/repo",
    };

    const expanded: DevServerConfig = {
      id: createDevServerId("expanded"),
      name: "Expanded",
      command: "npm run dev",
      cwd: "/repo",
      env: { PORT: "3000" },
      autoStart: false,
    };

    expect(minimal.env).toBeUndefined();
    expect(expanded.env?.PORT).toBe("3000");
    expect(expanded.autoStart).toBe(false);
  });

  it("DevServerLogEntry supports stdout and stderr streams", () => {
    const stdoutEntry: DevServerLogEntry = {
      timestamp: new Date().toISOString(),
      stream: "stdout",
      text: "ok",
    };

    const stderrEntry: DevServerLogEntry = {
      timestamp: new Date().toISOString(),
      stream: "stderr",
      text: "error",
    };

    expect(stdoutEntry.stream).toBe("stdout");
    expect(stderrEntry.stream).toBe("stderr");
  });
});
