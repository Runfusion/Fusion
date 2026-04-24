import { createConnection, type Socket } from "node:net";

export interface PortDetectionResult {
  url: string;
  port: number;
  source: string;
}

const RESERVED_DASHBOARD_PORT = 4040;
const DEFAULT_PROBE_TIMEOUT_MS = 1_000;
const DEFAULT_PROBE_HOST = "127.0.0.1";
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, "g");

export const FALLBACK_PREVIEW_PORTS = [5173, 3000, 4173, 6006, 8080, 4200, 4400, 8888, 4321, 4000] as const;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function isValidPreviewPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535 && port !== RESERVED_DASHBOARD_PORT;
}

function normalizeUrl(rawUrl: string, fallbackPort?: number): { url: string; port: number } | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let candidate = trimmed;
  if (/^\/\//.test(candidate)) {
    candidate = `http:${candidate}`;
  } else if (!/^https?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    return null;
  }

  const parsedPort = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : Number.NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : fallbackPort;
  if (!port || !isValidPreviewPort(port)) {
    return null;
  }

  const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const normalizedUrl = `${parsed.protocol}//${hostname}:${port}${pathname}${parsed.search}${parsed.hash}`;

  return { url: normalizedUrl, port };
}

function withSource(source: string, rawUrl: string, fallbackPort?: number): PortDetectionResult | null {
  const normalized = normalizeUrl(rawUrl, fallbackPort);
  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    source,
  };
}

function detectViteLine(line: string): PortDetectionResult | null {
  const localWithArrowMatch = line.match(/➜\s*Local:\s*(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (localWithArrowMatch) {
    return withSource("vite", localWithArrowMatch[1]);
  }

  const viteUrlMatch = line.match(/\bvite\b[^\n]*?(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (viteUrlMatch) {
    return withSource("vite", viteUrlMatch[1]);
  }

  return null;
}

function detectNextLine(line: string): PortDetectionResult | null {
  const nextStartedMatch = line.match(/ready\s*-\s*started server on [^,]+,\s*url:\s*(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (nextStartedMatch) {
    return withSource("nextjs", nextStartedMatch[1]);
  }

  const nextLocalMatch = line.match(/-\s*Local:\s*(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (nextLocalMatch) {
    return withSource("nextjs", nextLocalMatch[1]);
  }

  return null;
}

function detectStorybookLine(line: string): PortDetectionResult | null {
  const storybookLocalMatch = line.match(/=>\s*Local:\s*(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (storybookLocalMatch) {
    return withSource("storybook", storybookLocalMatch[1]);
  }

  const storybookUrlMatch = line.match(/\bstorybook\b[^\n]*?(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (storybookUrlMatch) {
    return withSource("storybook", storybookUrlMatch[1]);
  }

  return null;
}

function detectAngularLine(line: string): PortDetectionResult | null {
  const angularUrlMatch = line.match(/Angular Live Development Server[^\n]*?(https?:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (angularUrlMatch) {
    return withSource("angular", angularUrlMatch[1]);
  }

  const angularHostPortMatch = line.match(/Angular Live Development Server[^\n]*?(?:localhost|127\.0\.0\.1):(\d{2,5})/i);
  if (angularHostPortMatch) {
    const port = Number.parseInt(angularHostPortMatch[1], 10);
    return withSource("angular", `localhost:${port}`, port);
  }

  return null;
}

function detectGenericUrl(line: string): PortDetectionResult | null {
  const genericUrlMatch = line.match(/((?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d{2,5}(?:\/\S*)?)/i);
  if (!genericUrlMatch) {
    return null;
  }

  return withSource("generic-url", genericUrlMatch[1]);
}

function detectGenericPortLine(line: string): PortDetectionResult | null {
  const keywordPortMatch = line.match(/\b(?:ready|listening|started|available|compiled|running|server)\b[^\d]{0,50}(?:on\s+)?(?:port\s*[:=]?\s*)?(\d{2,5})\b/i);
  if (!keywordPortMatch) {
    return null;
  }

  const port = Number.parseInt(keywordPortMatch[1], 10);
  return withSource("generic-port", `localhost:${port}`, port);
}

function normalizeProbeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) {
    return DEFAULT_PROBE_HOST;
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.hostname || DEFAULT_PROBE_HOST;
  } catch {
    return trimmed;
  }
}

export function detectPortFromLogLine(line: string): PortDetectionResult | null {
  if (typeof line !== "string") {
    return null;
  }

  const cleanLine = stripAnsi(line).trim();
  if (!cleanLine) {
    return null;
  }

  return (
    detectViteLine(cleanLine)
    ?? detectNextLine(cleanLine)
    ?? detectStorybookLine(cleanLine)
    ?? detectAngularLine(cleanLine)
    ?? detectGenericUrl(cleanLine)
    ?? detectGenericPortLine(cleanLine)
  );
}

export function detectPortFromLogs(lines: string[]): PortDetectionResult | null {
  if (!Array.isArray(lines) || lines.length === 0) {
    return null;
  }

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const result = detectPortFromLogLine(lines[index] ?? "");
    if (result) {
      return result;
    }
  }

  return null;
}

function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket: Socket = createConnection({ host, port });

    const settle = (isOpen: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      if (isOpen) {
        socket.end();
      } else {
        socket.destroy();
      }
      resolve(isOpen);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export async function probeFallbackPorts(host = DEFAULT_PROBE_HOST, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<PortDetectionResult | null> {
  const safeHost = normalizeProbeHost(host);
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_PROBE_TIMEOUT_MS;

  for (const port of FALLBACK_PREVIEW_PORTS) {
    if (!isValidPreviewPort(port)) {
      continue;
    }

    // Probe sequentially so first responsive common port wins deterministically.
    const isOpen = await probePort(safeHost, port, safeTimeout);
    if (isOpen) {
      return {
        url: `http://${safeHost}:${port}`,
        port,
        source: "fallback-probe",
      };
    }
  }

  return null;
}
