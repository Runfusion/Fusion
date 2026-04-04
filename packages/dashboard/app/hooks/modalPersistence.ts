// Storage keys — each modal type has independent storage
export const STORED_PLANNING_KEY = "kb-planning-last-description";
export const STORED_SUBTASK_KEY = "kb-subtask-last-description";
export const STORED_MISSION_KEY = "kb-mission-last-goal";

// Planning persistence

export function savePlanningDescription(description: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORED_PLANNING_KEY, description);
  }
}

export function getPlanningDescription(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORED_PLANNING_KEY) || "";
}

export function clearPlanningDescription(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORED_PLANNING_KEY);
  }
}

// Subtask persistence

export function saveSubtaskDescription(description: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORED_SUBTASK_KEY, description);
  }
}

export function getSubtaskDescription(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORED_SUBTASK_KEY) || "";
}

export function clearSubtaskDescription(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORED_SUBTASK_KEY);
  }
}

// Mission persistence

export function saveMissionGoal(goal: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem(STORED_MISSION_KEY, goal);
  }
}

export function getMissionGoal(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(STORED_MISSION_KEY) || "";
}

export function clearMissionGoal(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem(STORED_MISSION_KEY);
  }
}
