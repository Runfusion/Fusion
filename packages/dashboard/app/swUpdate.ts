import { requestVersionCheck } from "./versionCheck";

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

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  controllerchange fires on first install too (sw.js calls clients.claim()), but there is no prior
  version to swap out — acting there races the in-flight chunk loads and strands the page on a blank
  shell. So the first-control case is still ignored outright.

  FN-516 changed what a genuine controller REPLACEMENT means. It used to reload the page directly, on
  the strength of the event alone. A worker can be replaced for reasons that have nothing to do with a
  new interface — a cache-policy change (this very task ships one), a re-registration, a claim after a
  failed install — so that was one of the paths reloading pages whose build had not moved. The event is
  now only a reason to LOOK: it asks the shared checker for a bounded read, and a reload happens only
  if that read proves a different live build, twice, exactly as for the periodic poll.

  Deliberately no permanent latch here. Marking "handled" before a decision exists would let a single
  unreadable check disable detection of a later, real deployment for the rest of the document. Repeated
  events are absorbed downstream by the checker's own in-flight, cooldown, and one-reload-per-document
  guards.
  */
  const wasControlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!wasControlled) return;
    void requestVersionCheck("service-worker");
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
