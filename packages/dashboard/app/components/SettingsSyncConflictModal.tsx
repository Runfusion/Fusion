import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./SettingsSyncConflictModal.css";

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single conflicting setting between local and remote */
export interface SettingsConflictEntry {
  key: string;
  localValue: unknown;
  remoteValue: unknown;
}

/** Resolution choice for a single setting */
export type ConflictResolution = "local" | "remote" | "manual";

/** A resolved setting to send back to the sync API */
export interface ConflictResolutionResult {
  key: string;
  value: unknown;
}

export interface SettingsSyncConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResolve: (resolutions: ConflictResolutionResult[]) => Promise<void>;
  conflicts: SettingsConflictEntry[];
  localNodeName: string;
  remoteNodeName: string;
  addToast: (message: string, type?: "success" | "error" | "info") => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a unified diff string from two values suitable for display.
 * Handles both string and non-string values (JSON stringified).
 */
function generateSettingsDiff(local: unknown, remote: unknown): string {
  const localStr = typeof local === "string" ? local : JSON.stringify(local, null, 2);
  const remoteStr = typeof remote === "string" ? remote : JSON.stringify(remote, null, 2);

  if (localStr === remoteStr) {
    return localStr;
  }

  const localLines = localStr.split("\n");
  const remoteLines = remoteStr.split("\n");
  const lines: string[] = [];

  const maxLen = Math.max(localLines.length, remoteLines.length);
  for (let i = 0; i < maxLen; i++) {
    const lLine = localLines[i];
    const rLine = remoteLines[i];
    if (lLine !== undefined && lLine !== rLine) {
      lines.push(`- ${lLine}`);
    }
    if (rLine !== undefined && rLine !== lLine) {
      lines.push(`+ ${rLine}`);
    }
    if (lLine !== undefined && lLine === rLine) {
      lines.push(`  ${lLine}`);
    }
  }
  return lines.join("\n");
}

interface ResolutionState {
  resolution: ConflictResolution;
  manualValue?: string;
}

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Modal dialog for resolving settings conflicts between local and remote nodes.
 * Displays side-by-side diffs with per-key resolution options.
 */
export function SettingsSyncConflictModal({
  isOpen,
  onClose,
  onResolve,
  conflicts,
  localNodeName,
  remoteNodeName,
  addToast,
}: SettingsSyncConflictModalProps) {
  const [resolutionMap, setResolutionMap] = useState<Record<string, ResolutionState>>({});
  const [isResolving, setIsResolving] = useState(false);

  // Initialize resolution map when conflicts change
  useEffect(() => {
    const initial: Record<string, ResolutionState> = {};
    for (const conflict of conflicts) {
      if (!resolutionMap[conflict.key]) {
        initial[conflict.key] = { resolution: "local" };
      }
    }
    if (Object.keys(initial).length > 0) {
      setResolutionMap((prev) => ({ ...prev, ...initial }));
    }
  }, [conflicts, resolutionMap]);

  // Escape key handler
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Handle resolution change for a specific key
  const handleResolutionChange = useCallback(
    (key: string, resolution: ConflictResolution) => {
      setResolutionMap((prev) => {
        const current = prev[key] ?? { resolution: "local" };
        if (resolution === "manual") {
          return {
            ...prev,
            [key]: {
              resolution: "manual",
              manualValue: current.manualValue ?? JSON.stringify(conflicts.find((c) => c.key === key)?.localValue ?? null, null, 2),
            },
          };
        }
        return {
          ...prev,
          [key]: { resolution },
        };
      });
    },
    [conflicts]
  );

  // Handle manual value change
  const handleManualValueChange = useCallback((key: string, value: string) => {
    setResolutionMap((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        resolution: "manual",
        manualValue: value,
      },
    }));
  }, []);

  // Bulk resolution actions
  const handleBulkResolution = useCallback(
    (resolution: ConflictResolution) => {
      const updates: Record<string, ResolutionState> = {};
      for (const conflict of conflicts) {
        updates[conflict.key] = { resolution };
      }
      setResolutionMap(updates);
    },
    [conflicts]
  );

  // Build resolution payload and submit
  const handleConfirm = useCallback(async () => {
    setIsResolving(true);
    try {
      const results: ConflictResolutionResult[] = conflicts.map((conflict) => {
        const state = resolutionMap[conflict.key] ?? { resolution: "local" as ConflictResolution };
        let value: unknown;
        switch (state.resolution) {
          case "remote":
            value = conflict.remoteValue;
            break;
          case "manual":
            try {
              value = JSON.parse(state.manualValue ?? "null");
            } catch {
              value = state.manualValue ?? null;
            }
            break;
          case "local":
          default:
            value = conflict.localValue;
            break;
        }
        return { key: conflict.key, value };
      });

      await onResolve(results);
      addToast("Settings conflicts resolved successfully", "success");
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to resolve conflicts";
      addToast(message, "error");
    } finally {
      setIsResolving(false);
    }
  }, [addToast, conflicts, onClose, onResolve, resolutionMap]);

  // Memoize diff output per conflict
  const diffs = useMemo(() => {
    const map: Record<string, string> = {};
    for (const conflict of conflicts) {
      map[conflict.key] = generateSettingsDiff(conflict.localValue, conflict.remoteValue);
    }
    return map;
  }, [conflicts]);

  if (!isOpen || conflicts.length === 0) {
    return null;
  }

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div
        className="modal modal-lg settings-sync-conflict-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Resolve Settings Conflicts"
      >
        <div className="modal-header">
          <h3>Resolve Settings Conflicts</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close conflict modal">
            &times;
          </button>
        </div>

        <div className="modal-body">
          <div className="settings-sync-conflict-modal__conflict-list">
            {conflicts.map((conflict) => {
              const state = resolutionMap[conflict.key] ?? { resolution: "local" };
              const diffOutput = diffs[conflict.key];

              return (
                <div key={conflict.key} className="settings-sync-conflict-modal__conflict-item">
                  <div className="settings-sync-conflict-modal__key">{conflict.key}</div>

                  <div className="settings-sync-conflict-modal__diff-panel">
                    <div className="settings-sync-conflict-modal__diff-side">
                      <div className="settings-sync-conflict-modal__diff-label">
                        {localNodeName}
                      </div>
                      <div className="settings-sync-conflict-modal__diff-content">
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{diffOutput}</pre>
                      </div>
                    </div>
                    <div className="settings-sync-conflict-modal__diff-side">
                      <div className="settings-sync-conflict-modal__diff-label">
                        {remoteNodeName}
                      </div>
                      <div className="settings-sync-conflict-modal__diff-content">
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>{diffOutput}</pre>
                      </div>
                    </div>
                  </div>

                  <div className="settings-sync-conflict-modal__resolution">
                    <label>
                      <input
                        type="radio"
                        name={`resolution-${conflict.key}`}
                        checked={state.resolution === "local"}
                        onChange={() => handleResolutionChange(conflict.key, "local")}
                      />
                      Keep Local
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`resolution-${conflict.key}`}
                        checked={state.resolution === "remote"}
                        onChange={() => handleResolutionChange(conflict.key, "remote")}
                      />
                      Keep Remote
                    </label>
                    <label>
                      <input
                        type="radio"
                        name={`resolution-${conflict.key}`}
                        checked={state.resolution === "manual"}
                        onChange={() => handleResolutionChange(conflict.key, "manual")}
                      />
                      Merge Manually
                    </label>
                  </div>

                  {state.resolution === "manual" && (
                    <textarea
                      className="settings-sync-conflict-modal__manual-input"
                      value={state.manualValue ?? ""}
                      onChange={(e) => handleManualValueChange(conflict.key, e.target.value)}
                      placeholder="Enter JSON value..."
                    />
                  )}
                </div>
              );
            })}
          </div>

          <div className="settings-sync-conflict-modal__bulk-actions">
            <button
              className="btn btn-sm"
              onClick={() => handleBulkResolution("local")}
              type="button"
            >
              Resolve All: Keep Local
            </button>
            <button
              className="btn btn-sm"
              onClick={() => handleBulkResolution("remote")}
              type="button"
            >
              Resolve All: Keep Remote
            </button>
          </div>
        </div>

        <div className="modal-actions settings-sync-conflict-modal__footer">
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleConfirm}
            disabled={isResolving}
          >
            {isResolving ? "Resolving..." : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
