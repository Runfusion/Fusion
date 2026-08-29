import { useState, useEffect, useCallback } from "react";
import type { ProjectItem, TaskItem, InteractiveData } from "../state.js";

export interface ProjectsState {
  projects: ProjectItem[];
  loading: boolean;
  error: string | null;
}

export interface TasksState {
  tasks: TaskItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useProjects(interactiveData: InteractiveData | null): ProjectsState {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!interactiveData) return;
    setLoading(true);
    setError(null);
    interactiveData.listProjects().then((p) => {
      setProjects(p);
      setLoading(false);
    }).catch((err: unknown) => {
      setProjects([]);
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [interactiveData]);

  return { projects, loading, error };
}

export function useTasks(
  interactiveData: InteractiveData | null,
  selectedProject: ProjectItem | null,
): TasksState {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  const refresh = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    if (!interactiveData || !selectedProject) {
      setTasks([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    interactiveData.listTasks(selectedProject.path).then((t) => {
      setTasks(t);
      setLoading(false);
    }).catch((err: unknown) => {
      setTasks([]);
      setLoading(false);
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [interactiveData, selectedProject, reloadTick]);

  return { tasks, loading, error, refresh };
}
