import { useMemo } from "react";
import { useShellContext as useNativeShellContext } from "../context/ShellContext";
import {
  parseShellContextFromUrl,
  type ShellContext as LaunchShellContext,
  type ShellKind,
} from "../shell-context";

export interface UseShellContextResult {
  shellContext: LaunchShellContext | null;
  isDesktopShell: boolean;
  isMobileShell: boolean;
}

function mapHostToKind(host: "web" | "mobile-shell" | "desktop-shell"): ShellKind | null {
  if (host === "desktop-shell") return "desktop";
  if (host === "mobile-shell") return "mobile";
  return null;
}

export function useShellContext(): UseShellContextResult {
  const { state } = useNativeShellContext();

  const shellContext = useMemo<LaunchShellContext | null>(() => {
    if (typeof window !== "undefined") {
      const parsedFromUrl = parseShellContextFromUrl(window.location.href);
      if (parsedFromUrl) {
        return parsedFromUrl;
      }
    }

    const shellKind = mapHostToKind(state.host);
    if (!shellKind) {
      return null;
    }

    if (shellKind === "desktop" && state.desktopMode === "local") {
      return {
        shellKind,
        shellMode: "local",
        capabilities: {
          canOpenConnectionManager: true,
        },
      };
    }

    const activeProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);
    if (!activeProfile) {
      return null;
    }

    return {
      shellKind,
      shellMode: "remote",
      profileId: activeProfile.id,
      serverBaseUrl: activeProfile.serverUrl.replace(/\/$/, ""),
      ...(activeProfile.name ? { serverLabel: activeProfile.name } : {}),
      capabilities: {
        canOpenConnectionManager: true,
      },
    };
  }, [state]);

  return {
    shellContext,
    isDesktopShell: shellContext?.shellKind === "desktop",
    isMobileShell: shellContext?.shellKind === "mobile",
  };
}
