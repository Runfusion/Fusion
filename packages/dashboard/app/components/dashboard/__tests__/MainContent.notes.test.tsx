import { lazy } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MainContentProps } from "../types";
vi.mock("../../../api", async (importOriginal) => { const { createDashboardApiMock } = await import("../../../test/mockApi"); return createDashboardApiMock(() => importOriginal<typeof import("../../../api")>()); });
import { MainContent } from "../MainContent";
const NotesProbe = lazy(async () => ({ default: ({ projectId }: { projectId?: string }) => <div data-testid="notes-probe">{projectId}</div> }));
function props(): MainContentProps { return { showBackendConnectionErrorPage: false, projectsError: null, t: ((key: string, fallback?: string) => fallback ?? key) as MainContentProps["t"], retryingProjects: false, handleRetryProjects: vi.fn(), shellApi: null, taskView: "notes", pluginDashboardViews: [], modalManager: {} as MainContentProps["modalManager"], handleChangeTaskView: vi.fn(), refreshAppSettings: vi.fn(), addToast: vi.fn(), currentProject: { id: "project-notes", name: "Notes" } as MainContentProps["currentProject"], NotesView: NotesProbe as MainContentProps["NotesView"] } as unknown as MainContentProps; }
describe("MainContent Notes", () => { it("mounts the lazy Notes contract with current project identity", async () => { render(<MainContent {...props()} />); expect(await screen.findByTestId("notes-probe")).toHaveTextContent("project-notes"); }); });
