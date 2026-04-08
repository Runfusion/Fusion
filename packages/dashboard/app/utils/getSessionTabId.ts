const SESSION_TAB_ID_KEY = "fusion-tab-id";

function createTabId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getSessionTabId(): string {
  if (typeof window === "undefined") {
    return "server-tab";
  }

  const existing = window.sessionStorage.getItem(SESSION_TAB_ID_KEY);
  if (existing) {
    return existing;
  }

  const next = createTabId();
  window.sessionStorage.setItem(SESSION_TAB_ID_KEY, next);
  return next;
}
