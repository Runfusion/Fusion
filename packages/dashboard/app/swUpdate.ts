import { reloadOnce } from "./versionCheck";

function promptUpdate(worker: ServiceWorker): void {
  worker.postMessage({ type: "SKIP_WAITING" });
}

function watchInstalling(installing: ServiceWorker): void {
  installing.addEventListener("statechange", () => {
    if (installing.state === "installed" && navigator.serviceWorker.controller) {
      promptUpdate(installing);
    }
  });
}

export function installSwUpdate(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  // controllerchange fires on first install too (sw.js calls clients.claim()),
  // but there's no prior version to swap out — reloading there races with the
  // in-flight chunk loads and strands the page on a blank shell. Only reload
  // when an existing controller is being replaced by a new one.
  const wasControlled = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !wasControlled) return;
    reloading = true;
    reloadOnce("service worker activated new version");
  });

  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      console.log("SW registered:", registration.scope);

      if (registration.waiting && navigator.serviceWorker.controller) {
        promptUpdate(registration.waiting);
      }

      if (registration.installing) {
        watchInstalling(registration.installing);
      }

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (installing) watchInstalling(installing);
      });
    })
    .catch((error) => {
      console.log("SW registration failed:", error);
    });
}
