export interface CentralCoreStub {
  registerProject(input: {
    name: string;
    path: string;
    isolationMode?: "in-process" | "child-process";
  }): Promise<{ id: string; name: string; path: string }>;
  /** Compatibility overload matching the PROMPT.md fallback contract. */
  registerProjectLegacy?(
    name: string,
    workingDir: string,
    options?: { isolationMode?: string }
  ): Promise<{ id: string; name: string; workingDirectory: string }>;
  listProjects(): Promise<Array<{ id: string; name: string; path: string; status?: string }>>;
  getProject(id: string): Promise<{ id: string; name: string; path: string; status?: string } | undefined>;
  getProjectByPath(path: string): Promise<{ id: string; name: string; path: string; status?: string } | undefined>;
  isProjectRegistered?(workingDir: string): Promise<boolean> | boolean;
  updateProject?(id: string, updates: { status?: "active" | "paused" | "errored" | "initializing" }): Promise<{ id: string; name: string; path: string; status?: string }>;
  getGlobalDir(): string;
}

export interface ProjectInfoStub {
  id: string;
  name: string;
  workingDirectory: string;
  status: "active" | "paused" | "errored";
  isolationMode: "in-process" | "child-process";
}
