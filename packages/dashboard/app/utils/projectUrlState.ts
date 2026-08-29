export function getProjectIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URL(window.location.href).searchParams.get("project");
}

export function replaceProjectIdInUrl(projectId: string | null): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  if (projectId && projectId.length > 0) {
    url.searchParams.set("project", projectId);
  } else {
    url.searchParams.delete("project");
  }

  const query = url.searchParams.toString();
  const nextUrl = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
  const existingState = window.history.state ?? {};
  /*
   * FNXC:ProjectUrlState 2026-07-02-00:00:
   * Project selection must survive browser refresh through the dashboard's existing `?project=` deep-link contract. Replace only the project query param so task/view/mailbox/room/PR params, hashes, and history state remain intact across desktop and mobile selector paths.
   */
  window.history.replaceState(existingState, "", nextUrl);
}
