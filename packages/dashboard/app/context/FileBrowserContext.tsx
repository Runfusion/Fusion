import { createContext, useContext } from "react";
import type { ReactNode } from "react";

export interface FileBrowserContextValue {
  openFile: (path: string, options?: { workspace?: string; line?: number; col?: number }) => void;
}

const FileBrowserContext = createContext<FileBrowserContextValue | null>(null);

export function FileBrowserProvider({
  openFile,
  children,
}: {
  openFile: FileBrowserContextValue["openFile"];
  children: ReactNode;
}) {
  return (
    <FileBrowserContext.Provider value={{ openFile }}>
      {children}
    </FileBrowserContext.Provider>
  );
}

export function useFileBrowser(): FileBrowserContextValue | null {
  return useContext(FileBrowserContext);
}
