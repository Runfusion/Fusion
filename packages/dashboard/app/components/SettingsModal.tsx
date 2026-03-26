import { useState, useEffect, useCallback } from "react";
import type { Settings } from "@hai/core";
import { fetchSettings, updateSettings } from "../api";
import type { ToastType } from "../hooks/useToast";

/**
 * Settings sections configuration.
 *
 * Each section groups related settings fields under a sidebar nav item.
 * To add a new section:
 *   1. Add an entry to SETTINGS_SECTIONS with a unique id and label
 *   2. Add a corresponding case in renderSectionFields()
 */
const SETTINGS_SECTIONS = [
  { id: "scheduling", label: "Scheduling" },
  { id: "worktrees", label: "Worktrees" },
  { id: "commands", label: "Commands" },
  { id: "merge", label: "Merge" },
] as const;

type SectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

interface SettingsModalProps {
  onClose: () => void;
  addToast: (message: string, type?: ToastType) => void;
}

export function SettingsModal({ onClose, addToast }: SettingsModalProps) {
  const [form, setForm] = useState<Settings & { worktreeInitCommand?: string }>({ maxConcurrent: 2, maxWorktrees: 4, pollIntervalMs: 15000, groupOverlappingFiles: false, autoMerge: false, recycleWorktrees: false, worktreeInitCommand: "" });
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<SectionId>(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    fetchSettings()
      .then((s) => {
        setForm(s);
        setLoading(false);
      })
      .catch((err) => {
        addToast(err.message, "error");
        setLoading(false);
      });
  }, [addToast]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleSave = useCallback(async () => {
    try {
      const payload = {
        ...form,
        worktreeInitCommand: form.worktreeInitCommand?.trim() || undefined,
      };
      await updateSettings(payload);
      addToast("Settings saved", "success");
      onClose();
    } catch (err: any) {
      addToast(err.message, "error");
    }
  }, [form, onClose, addToast]);

  const renderSectionFields = () => {
    switch (activeSection) {
      case "scheduling":
        return (
          <>
            <h4 className="settings-section-heading">Scheduling</h4>
            <div className="form-group">
              <label htmlFor="maxConcurrent">Max Concurrent Tasks</label>
              <input
                id="maxConcurrent"
                type="number"
                min={1}
                max={10}
                value={form.maxConcurrent}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxConcurrent: Number(e.target.value) }))
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor="pollIntervalMs">Poll Interval (ms)</label>
              <input
                id="pollIntervalMs"
                type="number"
                min={5000}
                step={1000}
                value={form.pollIntervalMs}
                onChange={(e) =>
                  setForm((f) => ({ ...f, pollIntervalMs: Number(e.target.value) }))
                }
              />
            </div>
            <div className="form-group">
              <label htmlFor="groupOverlappingFiles" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  id="groupOverlappingFiles"
                  type="checkbox"
                  checked={form.groupOverlappingFiles}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, groupOverlappingFiles: e.target.checked }))
                  }
                />
                Serialize tasks with overlapping files
              </label>
              <small>When enabled, tasks that modify the same files are queued serially to avoid merge conflicts</small>
            </div>
          </>
        );
      case "worktrees":
        return (
          <>
            <h4 className="settings-section-heading">Worktrees</h4>
            <div className="form-group">
              <label htmlFor="maxWorktrees">Max Worktrees</label>
              <input
                id="maxWorktrees"
                type="number"
                min={1}
                max={20}
                value={form.maxWorktrees}
                onChange={(e) =>
                  setForm((f) => ({ ...f, maxWorktrees: Number(e.target.value) }))
                }
              />
              <small>Limits total git worktrees including in-review tasks</small>
            </div>
            <div className="form-group">
              <label htmlFor="worktreeInitCommand">Worktree Init Command</label>
              <input
                id="worktreeInitCommand"
                type="text"
                placeholder="pnpm install"
                value={form.worktreeInitCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, worktreeInitCommand: e.target.value }))
                }
              />
              <small>Shell command to run in each new worktree after creation</small>
            </div>
            <div className="form-group">
              <label htmlFor="recycleWorktrees" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  id="recycleWorktrees"
                  type="checkbox"
                  checked={form.recycleWorktrees}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, recycleWorktrees: e.target.checked }))
                  }
                />
                Recycle worktrees
              </label>
              <small>When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup</small>
            </div>
          </>
        );
      case "commands":
        return (
          <>
            <h4 className="settings-section-heading">Commands</h4>
            <div className="form-group">
              <label htmlFor="testCommand">Test Command</label>
              <input
                id="testCommand"
                type="text"
                placeholder="e.g. pnpm test"
                value={form.testCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, testCommand: e.target.value || undefined }))
                }
              />
              <small>Command used to run tests — injected into generated task specs</small>
            </div>
            <div className="form-group">
              <label htmlFor="buildCommand">Build Command</label>
              <input
                id="buildCommand"
                type="text"
                placeholder="e.g. pnpm build"
                value={form.buildCommand || ""}
                onChange={(e) =>
                  setForm((f) => ({ ...f, buildCommand: e.target.value || undefined }))
                }
              />
              <small>Command used to build the project — injected into generated task specs</small>
            </div>
          </>
        );
      case "merge":
        return (
          <>
            <h4 className="settings-section-heading">Merge</h4>
            <div className="form-group">
              <label htmlFor="autoMerge" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <input
                  id="autoMerge"
                  type="checkbox"
                  checked={form.autoMerge}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, autoMerge: e.target.checked }))
                  }
                />
                Auto-merge completed tasks
              </label>
              <small>When enabled, tasks that pass review are automatically merged into the main branch</small>
            </div>
          </>
        );
    }
  };

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>Settings</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        {loading ? (
          <div style={{ padding: "20px", textAlign: "center" }}>Loading…</div>
        ) : (
          <div className="settings-layout">
            <nav className="settings-sidebar">
              {SETTINGS_SECTIONS.map((section) => (
                <button
                  key={section.id}
                  className={`settings-nav-item${activeSection === section.id ? " active" : ""}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  {section.label}
                </button>
              ))}
            </nav>
            <div className="settings-content">
              {renderSectionFields()}
            </div>
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={loading}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
