export type ActiveSessionKind = "executor" | "step-session" | "workflow-step" | "step-session-parallel";

export interface ActiveSessionRegistration {
  taskId: string;
  kind: ActiveSessionKind;
  ownerKey: string;
}

export interface ActiveSessionRecord extends ActiveSessionRegistration {
  registeredAt: number;
}

class ActiveSessionRegistry {
  private readonly records = new Map<string, ActiveSessionRecord>();

  registerPath(worktreePath: string, registration: ActiveSessionRegistration): void {
    if (this.records.has(worktreePath)) {
      console.warn(`[active-session-registry] overwriting existing registration for ${worktreePath}`);
    }
    this.records.set(worktreePath, {
      ...registration,
      registeredAt: Date.now(),
    });
  }

  unregisterPath(worktreePath: string): void {
    this.records.delete(worktreePath);
  }

  lookupByPath(worktreePath: string): ActiveSessionRecord | null {
    return this.records.get(worktreePath) ?? null;
  }

  isPathActive(worktreePath: string): boolean {
    return this.records.has(worktreePath);
  }

  pathsForTask(taskId: string): string[] {
    const paths: string[] = [];
    for (const [path, record] of this.records.entries()) {
      if (record.taskId === taskId) {
        paths.push(path);
      }
    }
    return paths;
  }

  clear(): void {
    this.records.clear();
  }
}

export const activeSessionRegistry = new ActiveSessionRegistry();
