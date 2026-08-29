// Ambient host interop (no runtime dependency on @fusion/dashboard).
// Vite aliases resolve these to the real dashboard sources at build time.
// FNXC:Quality 2026-07-19-12:00: The Quality plugin consumes existing artifact media through this narrow host bridge so inline video elements receive the tokenized URL they require without importing dashboard client APIs.
// Mirrors fusion-plugin-compound-engineering/src/dashboard-interop.d.ts.

declare module "@fusion/dashboard/app/plugins/types" {
  import type { Task } from "@fusion/core";

  export interface PluginDashboardViewContext {
    projectId?: string;
    tasks: Task[];
    openTaskDetail: (task: Task, initialTab?: string) => void;
  }
}

declare module "@fusion/dashboard/app/api/tasks/task-content" {
  export type ArtifactType = "document" | "image" | "video" | "audio" | "other";

  export interface ArtifactWithTask {
    id: string;
    type: ArtifactType;
    title: string;
    taskId?: string;
    authorId?: string;
    authorType?: string;
  }

  export function artifactMediaUrlWithToken(id: string, projectId?: string): string;
}

declare module "@fusion/dashboard/app/components/ViewHeader" {
  import type { ComponentType, ReactNode } from "react";
  import type { LucideProps } from "lucide-react";

  export interface ViewHeaderProps {
    icon: ComponentType<LucideProps>;
    title: string;
    actions?: ReactNode;
    titleId?: string;
  }

  export function ViewHeader(props: ViewHeaderProps): ReactNode;
}
