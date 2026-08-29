import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReviewArtifactGenerationEligible,
  type Artifact,
  type ProjectSettings,
  type Task,
  type TaskDocument,
} from "@fusion/core";

const SCENARIO_DOCUMENT_KEY = "review-artifact-scenario";
const MAX_DURATION_MS = 15_000;
const DEFAULT_DURATION_MS = 3_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const NAVIGATION_TIMEOUT_MS = 10_000;

export interface FeatureVideoPage {
  goto(url: string, options: { timeout: number; waitUntil: "load" }): Promise<unknown>;
  video(): { path(): Promise<string> } | null;
}

export interface FeatureVideoContext {
  newPage(): Promise<FeatureVideoPage>;
  close(): Promise<void>;
}

export interface FeatureVideoBrowser {
  newContext(options: { recordVideo: { dir: string; size: { width: number; height: number } } }): Promise<FeatureVideoContext>;
  close(): Promise<void>;
}

/** Injectable seam so unit tests never launch a real browser. */
export interface FeatureVideoBrowserClient {
  launch(options: { executablePath?: string; headless: boolean }): Promise<FeatureVideoBrowser>;
}

export interface FeatureVideoStore {
  getTaskDocument(taskId: string, key: string): Promise<TaskDocument | null>;
  registerArtifact(input: {
    type: "video";
    taskId: string;
    title: string;
    description: string;
    mimeType: "video/webm";
    data: Buffer;
    authorId: string;
    authorType: "system";
  }): Promise<Artifact>;
}

export type FeatureVideoResult =
  | { status: "skipped"; reason: "gated-off" | "no-scenario" | "scenario-url-not-local" | "browser-unavailable" | "navigation-failed" }
  | { status: "failed"; reason: "size-cap-exceeded" | "capture-failed" }
  | { status: "captured"; artifactId: string };

export interface GenerateFeatureVideoOptions {
  store: FeatureVideoStore;
  task: Pick<Task, "id" | "title"> & { prompt?: string };
  settings: Pick<ProjectSettings, "reviewArtifacts">;
  client?: FeatureVideoBrowserClient;
  executablePath?: string;
  durationMs?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface Scenario {
  baseUrl: string;
  targetRoute: string;
  flowScript?: string;
}

/*
FNXC:ReviewArtifacts 2026-07-19-10:00:
Feature-video generation is a gated, best-effort completion deliverable. It uses the
existing artifact registry (not a parallel media store), accepts only loopback scenario
URLs, and returns a result for every failure so recording can never fail task completion.
*/
export function shouldGenerateReviewArtifacts(
  task: Pick<Task, "id"> & { prompt?: string },
  settings: Pick<ProjectSettings, "reviewArtifacts">,
): boolean {
  return isReviewArtifactGenerationEligible(settings, task.prompt);
}

/**
 * Captures a short WebM from the persisted local scenario contract and registers its
 * bytes through TaskStore. This boundary intentionally swallows all capture failures.
 */
export async function generateFeatureVideo(options: GenerateFeatureVideoOptions): Promise<FeatureVideoResult> {
  if (!shouldGenerateReviewArtifacts(options.task, options.settings)) {
    return { status: "skipped", reason: "gated-off" };
  }

  let scenarioDocument: TaskDocument | null;
  try {
    scenarioDocument = await options.store.getTaskDocument(options.task.id, SCENARIO_DOCUMENT_KEY);
  } catch {
    return { status: "skipped", reason: "no-scenario" };
  }
  const scenario = parseScenario(scenarioDocument?.content);
  if (!scenario) return { status: "skipped", reason: "no-scenario" };
  const url = resolveLoopbackScenarioUrl(scenario);
  if (!url) return { status: "skipped", reason: "scenario-url-not-local" };

  const executablePath = options.client ? options.executablePath : await probeBrowserExecutable(options.executablePath);
  if (!options.client && !executablePath) return { status: "skipped", reason: "browser-unavailable" };
  const client = options.client ?? await createPlaywrightFeatureVideoClient();
  if (!client) return { status: "skipped", reason: "browser-unavailable" };

  let recordingDir: string | undefined;
  let browser: FeatureVideoBrowser | undefined;
  let context: FeatureVideoContext | undefined;
  try {
    recordingDir = await mkdtemp(join(tmpdir(), "fusion-feature-video-"));
    try {
      browser = await client.launch({ executablePath, headless: true });
    } catch {
      return { status: "skipped", reason: "browser-unavailable" };
    }
    context = await browser.newContext({ recordVideo: { dir: recordingDir, size: { width: 1280, height: 720 } } });
    const page = await context.newPage();
    try {
      await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: "load" });
    } catch {
      return { status: "skipped", reason: "navigation-failed" };
    }
    const video = page.video();
    if (!video) return { status: "failed", reason: "capture-failed" };
    await (options.sleep ?? defaultSleep)(Math.min(Math.max(options.durationMs ?? DEFAULT_DURATION_MS, 0), MAX_DURATION_MS));
    await context.close();
    context = undefined;
    const data = await readFile(await video.path());
    if (data.byteLength > (options.maxBytes ?? DEFAULT_MAX_BYTES)) {
      return { status: "failed", reason: "size-cap-exceeded" };
    }
    const artifact = await options.store.registerArtifact({
      type: "video",
      taskId: options.task.id,
      title: `Feature video: ${options.task.title ?? options.task.id}`,
      description: `Best-effort feature recording for ${scenario.targetRoute}.`,
      mimeType: "video/webm",
      data,
      authorId: "executor",
      authorType: "system",
    });
    return { status: "captured", artifactId: artifact.id };
  } catch {
    return { status: "failed", reason: "capture-failed" };
  } finally {
    await safeClose(context);
    await safeClose(browser);
    if (recordingDir) await rm(recordingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseScenario(content: string | undefined): Scenario | undefined {
  if (!content) return undefined;
  try {
    const value = JSON.parse(content) as Partial<Scenario>;
    return typeof value.baseUrl === "string" && typeof value.targetRoute === "string" && value.targetRoute.startsWith("/")
      ? { baseUrl: value.baseUrl, targetRoute: value.targetRoute, ...(typeof value.flowScript === "string" ? { flowScript: value.flowScript } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveLoopbackScenarioUrl(scenario: Scenario): string | undefined {
  try {
    const base = new URL(scenario.baseUrl);
    if (!/^https?:$/.test(base.protocol) || !["127.0.0.1", "localhost", "::1"].includes(base.hostname)) return undefined;
    return new URL(scenario.targetRoute, base).toString();
  } catch {
    return undefined;
  }
}

/*
FNXC:ReviewArtifacts 2026-07-19-10:00:
playwright-core does not download Chromium. Probe only known local executable locations
before launch so an unavailable browser is a clean skip, never a completion failure.
*/
async function probeBrowserExecutable(explicit?: string): Promise<string | undefined> {
  const candidates = [
    explicit,
    process.env.FUSION_BROWSER_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    ...(process.platform === "darwin" ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ] : process.platform === "win32" ? [] : [
      "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    ]),
  ].filter((candidate): candidate is string => Boolean(candidate?.trim()));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue with the next local candidate; no subprocess or download is used.
    }
  }
  return undefined;
}

async function createPlaywrightFeatureVideoClient(): Promise<FeatureVideoBrowserClient | undefined> {
  try {
    const playwright = await import("playwright-core") as unknown as { chromium: FeatureVideoBrowserClient };
    return playwright.chromium;
  } catch {
    return undefined;
  }
}

async function safeClose(value: { close(): Promise<void> } | undefined): Promise<void> {
  await value?.close().catch(() => undefined);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
