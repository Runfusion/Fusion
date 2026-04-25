import { useState, useEffect } from "react";
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
}

export function useProjects(interactiveData: InteractiveData | null): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ projects: [], loading: false, error: null });

  useEffect(() => {
    if (!interactiveData) return;
    setState({ projects: [], loading: true, error: null });
    interactiveData.listProjects().then((projects) => {
      setState({ projects, loading: false, error: null });
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setState({ projects: [], loading: false, error: message });
    });
  }, [interactiveData]);

  return state;
}

export function useTasks(
  interactiveData: InteractiveData | null,
  selectedProject: ProjectItem | null,
): TasksState {
  const [state, setState] = useState<TasksState>({ tasks: [], loading: false, error: null });

  useEffect(() => {
    if (!interactiveData || !selectedProject) {
      setState({ tasks: [], loading: false, error: null });
      return;
    }
    setState({ tasks: [], loading: true, error: null });
    interactiveData.listTasks(selectedProject.path).then((tasks) => {
      setState({ tasks, loading: false, error: null });
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setState({ tasks: [], loading: false, error: message });
    });
  }, [interactiveData, selectedProject]);

  return state;
}
