declare const __BUILD_VERSION__: string;

const RELOAD_FLAG = "fusion:version-reload";

function reloadOnce(reason: string): void {
  if (sessionStorage.getItem(RELOAD_FLAG)) {
    console.warn("[versionCheck] reload already attempted, suppressing", reason);
    return;
  }
  sessionStorage.setItem(RELOAD_FLAG, "1");
  console.info("[versionCheck] reloading:", reason);
  window.location.reload();
}

export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|ChunkLoadError/i.test(
    message,
  );
}

export function handleChunkLoadError(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  reloadOnce(`chunk load error: ${(error as Error)?.message ?? error}`);
  return true;
}

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

let checkInFlight = false;

async function checkVersion(): Promise<void> {
  if (checkInFlight || document.visibilityState !== "visible") return;
  checkInFlight = true;
  try {
    const remote = await fetchRemoteVersion();
    if (remote && remote !== __BUILD_VERSION__) {
      reloadOnce(`build version changed: ${__BUILD_VERSION__} -> ${remote}`);
    }
  } finally {
    checkInFlight = false;
  }
}

export function installVersionCheck(): void {
  if (!import.meta.env.PROD) return;
  // Clear stale flag once a fresh page has rendered successfully.
  window.setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5_000);
  document.addEventListener("visibilitychange", () => {
    void checkVersion();
  });
  window.addEventListener("focus", () => {
    void checkVersion();
  });
  // Initial check after load to catch tabs restored from bfcache.
  window.setTimeout(() => void checkVersion(), 2_000);
}
