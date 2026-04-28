import { useState, useMemo, useCallback, useEffect } from "react";
import { Loader2 } from "lucide-react";
import "./MemoryView.css";
import "./SettingsModal.css";
import type { MemoryFileInfo, MemoryRetrievalTestResult } from "../api";
import { FileEditor } from "./FileEditor";
import { useMemoryData } from "../hooks/useMemoryData";

interface MemoryViewProps {
  projectId?: string;
  addToast: (message: string, type: "success" | "error" | "info") => void;
}

type Tab = "working" | "insights" | "engines";

/** Known category headers in the insights file */
const CATEGORY_HEADERS: Record<string, string> = {
  "Patterns": "pattern",
  "Principles": "principle",
  "Conventions": "convention",
  "Pitfalls": "pitfall",
  "Context": "context",
};

const MEMORY_LAYER_NAMES: Record<MemoryFileInfo["layer"], string> = {
  "long-term": "Long-term",
  daily: "Daily",
  dreams: "Dreams",
};

const MEMORY_LAYER_DESCRIPTIONS: Record<MemoryFileInfo["layer"], string> = {
  "long-term": "Curated durable decisions, conventions, constraints, and pitfalls promoted from dreams.",
  daily: "Raw daily observations, open loops, and running context for dream processing.",
  dreams: "Synthesized patterns and open loops promoted from daily memory.",
};

interface ParsedInsightCategory {
  name: string;
  key: string;
  items: string[];
  expanded: boolean;
}

/** Parse insights markdown content into categorized sections */
function parseInsightsContent(content: string | null): ParsedInsightCategory[] {
  if (!content) return [];

  const categories: ParsedInsightCategory[] = [];
  const sections = content.split(/(?=^## )/m);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Check if this is a category header
    const match = trimmed.match(/^##\s+(.+?)(\n|$)/);
    if (match) {
      const header = match[1].trim();
      const key = CATEGORY_HEADERS[header] ?? header.toLowerCase();
      const body = trimmed.slice(match[0].length).trim();

      // Extract bullet points
      const items = body
        .split("\n")
        .map((line) => line.replace(/^-\s+/, "").trim())
        .filter((line) => line.length > 0 && (line.startsWith("- ") || line.startsWith("* ")));

      if (items.length > 0 || body.length > 0) {
        categories.push({
          name: header,
          key,
          items: items.length > 0 ? items : (body.length > 0 ? [body] : []),
          expanded: true,
        });
      }
    }
  }

  return categories;
}

/** Parse the "Last Updated" timestamp from insights content */
function parseLastUpdated(content: string | null): string | null {
  if (!content) return null;
  const match = content.match(/##\s+Last\s+Updated:\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

/** Count total insights from parsed categories */
function countTotalInsights(categories: ParsedInsightCategory[]): number {
  return categories.reduce((sum, cat) => sum + cat.items.length, 0);
}

/** Get backend display name */
function getBackendDisplayName(backend: string): string {
  switch (backend) {
    case "file":
      return "File (.fusion/memory/)";
    case "readonly":
      return "Read-Only";
    case "qmd":
      return "QMD (Quantized Memory Distillation)";
    default:
      return backend;
  }
}

/** Get health badge text */
function getHealthBadgeText(health: "healthy" | "warning" | "issues"): string {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "warning":
      return "Warning";
    case "issues":
      return "Issues Found";
  }
}

export function MemoryView({ projectId, addToast }: MemoryViewProps) {
  const [activeTab, setActiveTab] = useState<Tab>("working");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [editingInsights, setEditingInsights] = useState(false);
  const [insightsEditorContent, setInsightsEditorContent] = useState<string | null>(null);
  const [memorySettingsDraft, setMemorySettingsDraft] = useState({
    memoryEnabled: true,
    memoryAutoSummarizeEnabled: false,
    memoryAutoSummarizeThresholdChars: 50_000,
    memoryAutoSummarizeSchedule: "0 3 * * *",
    memoryDreamsEnabled: false,
    memoryDreamsSchedule: "0 4 * * *",
  });
  const [memoryTestQuery, setMemoryTestQuery] = useState("");
  const [memoryTestLoading, setMemoryTestLoading] = useState(false);
  const [memoryTestResult, setMemoryTestResult] = useState<MemoryRetrievalTestResult | null>(null);

  const {
    insightsContent,
    insightsLoading,
    insightsExists,
    saveInsights,
    memorySettings,
    settingsLoading,
    saveMemorySettings,
    savingMemorySettings,
    backendStatus,
    backendLoading,
    extractInsights,
    extracting,
    auditReport,
    auditLoading,
    refreshAudit,
    compactMemory,
    compacting,
    installQmdAction,
    installingQmd,
    testRetrieval,
    memoryFiles,
    memoryFilesLoading,
    selectedFilePath,
    selectedFileContent,
    selectedFileLoading,
    selectedFileDirty,
    setSelectedFileContent,
    selectFile,
    saveSelectedFile,
    savingSelectedFile,
    reloadMemoryFiles,
    triggerDreamNow,
    dreamRunning,
  } = useMemoryData({ projectId });

  useEffect(() => {
    setMemorySettingsDraft(memorySettings);
  }, [memorySettings]);

  const memorySettingsDirty = useMemo(() => (
    memorySettingsDraft.memoryEnabled !== memorySettings.memoryEnabled
    || memorySettingsDraft.memoryAutoSummarizeEnabled !== memorySettings.memoryAutoSummarizeEnabled
    || memorySettingsDraft.memoryAutoSummarizeThresholdChars !== memorySettings.memoryAutoSummarizeThresholdChars
    || memorySettingsDraft.memoryAutoSummarizeSchedule !== memorySettings.memoryAutoSummarizeSchedule
    || memorySettingsDraft.memoryDreamsEnabled !== memorySettings.memoryDreamsEnabled
    || memorySettingsDraft.memoryDreamsSchedule !== memorySettings.memoryDreamsSchedule
  ), [memorySettingsDraft, memorySettings]);

  const selectedMemoryFile = useMemo(
    () => memoryFiles.find((file) => file.path === selectedFilePath),
    [memoryFiles, selectedFilePath],
  );

  const selectedLayerDescription = selectedMemoryFile
    ? MEMORY_LAYER_DESCRIPTIONS[selectedMemoryFile.layer]
    : "Edits the selected memory file.";

  // Parse insights content
  const parsedCategories = useMemo(
    () => parseInsightsContent(insightsContent),
    [insightsContent],
  );

  const totalInsights = useMemo(
    () => countTotalInsights(parsedCategories),
    [parsedCategories],
  );

  const lastUpdated = useMemo(
    () => parseLastUpdated(insightsContent),
    [insightsContent],
  );

  // Toggle category expansion
  const toggleCategory = useCallback((key: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleSelectMemoryFile = useCallback(async (path: string) => {
    try {
      await selectFile(path);
    } catch {
      addToast("Failed to load memory file", "error");
    }
  }, [selectFile, addToast]);

  const handleSaveSelectedFile = useCallback(async () => {
    try {
      await saveSelectedFile();
      addToast("Memory saved", "success");
    } catch {
      addToast("Failed to save memory", "error");
    }
  }, [saveSelectedFile, addToast]);

  const handleSaveMemorySettings = useCallback(async () => {
    if (!memorySettingsDirty) {
      return;
    }

    const patch: Partial<typeof memorySettingsDraft> = {};

    if (memorySettingsDraft.memoryEnabled !== memorySettings.memoryEnabled) {
      patch.memoryEnabled = memorySettingsDraft.memoryEnabled;
    }
    if (memorySettingsDraft.memoryAutoSummarizeEnabled !== memorySettings.memoryAutoSummarizeEnabled) {
      patch.memoryAutoSummarizeEnabled = memorySettingsDraft.memoryAutoSummarizeEnabled;
    }
    if (memorySettingsDraft.memoryAutoSummarizeThresholdChars !== memorySettings.memoryAutoSummarizeThresholdChars) {
      patch.memoryAutoSummarizeThresholdChars = memorySettingsDraft.memoryAutoSummarizeThresholdChars;
    }
    if (memorySettingsDraft.memoryAutoSummarizeSchedule !== memorySettings.memoryAutoSummarizeSchedule) {
      patch.memoryAutoSummarizeSchedule = memorySettingsDraft.memoryAutoSummarizeSchedule;
    }
    if (memorySettingsDraft.memoryDreamsEnabled !== memorySettings.memoryDreamsEnabled) {
      patch.memoryDreamsEnabled = memorySettingsDraft.memoryDreamsEnabled;
    }
    if (memorySettingsDraft.memoryDreamsSchedule !== memorySettings.memoryDreamsSchedule) {
      patch.memoryDreamsSchedule = memorySettingsDraft.memoryDreamsSchedule;
    }

    try {
      await saveMemorySettings(patch);
      addToast("Memory settings saved", "success");
    } catch {
      addToast("Failed to save memory settings", "error");
    }
  }, [memorySettingsDirty, memorySettingsDraft, memorySettings, saveMemorySettings, addToast]);

  const handleInstallQmd = useCallback(async () => {
    try {
      const result = await installQmdAction();
      addToast(
        result.qmdAvailable ? "qmd installed successfully" : "qmd install finished, but qmd is still unavailable",
        result.qmdAvailable ? "success" : "info",
      );
    } catch {
      addToast("Failed to install qmd", "error");
    }
  }, [installQmdAction, addToast]);

  const handleTestRetrieval = useCallback(async () => {
    setMemoryTestLoading(true);
    setMemoryTestResult(null);

    try {
      const result = await testRetrieval(memoryTestQuery);
      setMemoryTestResult(result);
      addToast(
        result.qmdAvailable ? "Memory retrieval test complete" : "qmd is not installed; local fallback was used",
        result.qmdAvailable ? "success" : "info",
      );
    } catch {
      addToast("Failed to test memory retrieval", "error");
    } finally {
      setMemoryTestLoading(false);
    }
  }, [memoryTestQuery, testRetrieval, addToast]);

  const handleDreamNow = useCallback(async () => {
    try {
      await triggerDreamNow();
      addToast("Dream processing completed", "success");
      await reloadMemoryFiles();
    } catch (error) {
      addToast(error instanceof Error ? error.message : "Failed to run dream processing", "error");
    }
  }, [triggerDreamNow, reloadMemoryFiles, addToast]);

  // Handle compact memory
  const handleCompactMemory = useCallback(async () => {
    try {
      await compactMemory(selectedFilePath);
      addToast("Memory file compacted", "success");
    } catch {
      addToast("Failed to compact memory", "error");
    }
  }, [compactMemory, selectedFilePath, addToast]);

  // Handle extract insights
  const handleExtractInsights = useCallback(async () => {
    try {
      const result = await extractInsights();
      addToast(result.summary, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to extract insights", "error");
    }
  }, [extractInsights, addToast]);

  // Handle save insights (from raw editor)
  const handleSaveInsights = useCallback(async () => {
    if (insightsEditorContent === null) return;
    try {
      await saveInsights(insightsEditorContent);
      setEditingInsights(false);
      setInsightsEditorContent(null);
      addToast("Insights saved", "success");
    } catch {
      addToast("Failed to save insights", "error");
    }
  }, [insightsEditorContent, saveInsights, addToast]);

  // Start editing insights
  const handleStartEditingInsights = useCallback(() => {
    setInsightsEditorContent(insightsContent ?? "");
    setEditingInsights(true);
  }, [insightsContent]);

  // Cancel editing insights
  const handleCancelEditingInsights = useCallback(() => {
    setEditingInsights(false);
    setInsightsEditorContent(null);
  }, []);

  const backendStatusResolved = !backendLoading && backendStatus !== null;
  const isWritable = backendStatus?.capabilities?.writable ?? false;

  return (
    <div className="memory-view">
      {/* Header */}
      <div className="memory-view-header">
        <div>
          <h2>Memory</h2>
          <p className="memory-view-description">
            Working memory, long-term insights, and engine status
          </p>
        </div>
      </div>

      {/* Tab bar */}
      <div className="memory-view-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "working"}
          className={`memory-view-tab${activeTab === "working" ? " memory-view-tab--active" : ""}`}
          onClick={() => setActiveTab("working")}
          data-testid="memory-tab-working"
        >
          Working Memory
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "insights"}
          className={`memory-view-tab${activeTab === "insights" ? " memory-view-tab--active" : ""}`}
          onClick={() => setActiveTab("insights")}
          data-testid="memory-tab-insights"
        >
          Insights
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "engines"}
          className={`memory-view-tab${activeTab === "engines" ? " memory-view-tab--active" : ""}`}
          onClick={() => setActiveTab("engines")}
          data-testid="memory-tab-engines"
        >
          Engines
        </button>
      </div>

      {/* Content area */}
      <div className="memory-view-content">
        {/* Working Memory Tab */}
        {activeTab === "working" && (
          <div className="memory-working-tab">
            {backendStatusResolved && !isWritable && (
              <div className="memory-readonly-banner">
                This memory backend is read-only. Changes cannot be saved.
              </div>
            )}

            {memoryFilesLoading || selectedFileLoading ? (
              <div className="memory-empty-state">
                <Loader2 size={20} className="animate-spin" />
                <span>Loading memory file…</span>
              </div>
            ) : (
              <>
                <div className="memory-editor-section">
                  <div className="form-group">
                    <label htmlFor="memoryViewFilePath">Memory File</label>
                    <select
                      id="memoryViewFilePath"
                      className="select"
                      value={selectedFilePath}
                      onChange={(event) => {
                        void handleSelectMemoryFile(event.target.value);
                      }}
                      disabled={selectedFileDirty}
                    >
                      {memoryFiles.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.label} - {file.path}
                        </option>
                      ))}
                    </select>
                    <small>
                      {selectedFileDirty
                        ? "Save or discard the current edits before switching files."
                        : "Choose any project memory file to view or edit."}
                    </small>
                  </div>

                  {selectedMemoryFile && (
                    <div className="memory-file-summary">
                      <span>{MEMORY_LAYER_NAMES[selectedMemoryFile.layer]}</span>
                      <strong>{selectedMemoryFile.path}</strong>
                      <small>
                        {selectedMemoryFile.size.toLocaleString()} bytes · updated {new Date(selectedMemoryFile.updatedAt).toLocaleString()}
                      </small>
                    </div>
                  )}

                  <div className="form-group">
                    <label>{selectedMemoryFile?.label || "Memory Editor"}</label>
                    <small>{selectedLayerDescription}</small>
                    <div className="memory-editor-container">
                      <FileEditor
                        content={selectedFileContent}
                        onChange={setSelectedFileContent}
                        readOnly={!isWritable}
                        filePath={selectedFilePath}
                      />
                    </div>
                  </div>
                </div>

                <div className="memory-action-bar">
                  <span className="memory-char-count">{selectedFileContent.length} characters</span>
                  <div className="memory-flex-spacer" />
                  {isWritable && selectedFileContent.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleCompactMemory}
                      disabled={compacting || selectedFileDirty}
                    >
                      {compacting ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Compacting…
                        </>
                      ) : (
                        "Compact Selected File"
                      )}
                    </button>
                  )}
                  {selectedFileDirty && isWritable && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={handleSaveSelectedFile}
                      disabled={savingSelectedFile}
                    >
                      {savingSelectedFile ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Saving…
                        </>
                      ) : (
                        "Save"
                      )}
                    </button>
                  )}
                </div>

                <div className="memory-config-section">
                  <div className="memory-settings-group">
                    <div className="form-group">
                      <label htmlFor="memoryDreamsEnabled" className="checkbox-label">
                        <input
                          id="memoryDreamsEnabled"
                          type="checkbox"
                          checked={memorySettingsDraft.memoryDreamsEnabled}
                          onChange={(event) => {
                            setMemorySettingsDraft((prev) => ({
                              ...prev,
                              memoryDreamsEnabled: event.target.checked,
                            }));
                          }}
                          disabled={!memorySettingsDraft.memoryEnabled || settingsLoading}
                        />
                        Process dreams from daily memory
                      </label>
                      <small>Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md.</small>
                    </div>

                    {memorySettingsDraft.memoryEnabled && memorySettingsDraft.memoryDreamsEnabled && (
                      <>
                        <div className="form-group">
                          <label htmlFor="memoryDreamsSchedule">Dream Schedule</label>
                          <input
                            id="memoryDreamsSchedule"
                            type="text"
                            className="input"
                            value={memorySettingsDraft.memoryDreamsSchedule}
                            onChange={(event) => {
                              setMemorySettingsDraft((prev) => ({
                                ...prev,
                                memoryDreamsSchedule: event.target.value,
                              }));
                            }}
                            placeholder="0 4 * * *"
                            disabled={settingsLoading}
                          />
                          <small>Cron expression for dream processing.</small>
                        </div>
                        <div className="form-group">
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={handleDreamNow}
                            disabled={dreamRunning || !memorySettingsDraft.memoryDreamsEnabled}
                          >
                            {dreamRunning ? (
                              <>
                                <Loader2 size={14} className="animate-spin" />
                                Dreaming…
                              </>
                            ) : (
                              "Dream Now"
                            )}
                          </button>
                          <small>Manually trigger dream processing now.</small>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="memory-settings-group">
                    <div className="form-group">
                      <label htmlFor="memoryAutoSummarizeEnabled" className="checkbox-label">
                        <input
                          id="memoryAutoSummarizeEnabled"
                          type="checkbox"
                          checked={memorySettingsDraft.memoryAutoSummarizeEnabled}
                          onChange={(event) => {
                            setMemorySettingsDraft((prev) => ({
                              ...prev,
                              memoryAutoSummarizeEnabled: event.target.checked,
                            }));
                          }}
                          disabled={!memorySettingsDraft.memoryEnabled || settingsLoading}
                        />
                        Auto-Summarize Memory
                      </label>
                      <small>Automatically compact memory when it exceeds the threshold on a schedule</small>
                    </div>

                    {memorySettingsDraft.memoryEnabled && memorySettingsDraft.memoryAutoSummarizeEnabled && (
                      <>
                        <div className="form-group">
                          <label htmlFor="memoryAutoSummarizeThresholdChars">Compaction Threshold (chars)</label>
                          <input
                            id="memoryAutoSummarizeThresholdChars"
                            type="number"
                            className="input"
                            value={memorySettingsDraft.memoryAutoSummarizeThresholdChars}
                            onChange={(event) => {
                              setMemorySettingsDraft((prev) => ({
                                ...prev,
                                memoryAutoSummarizeThresholdChars: parseInt(event.target.value, 10) || 50000,
                              }));
                            }}
                            min={1000}
                            disabled={settingsLoading}
                          />
                          <small>Memory will be compacted when it exceeds this character count</small>
                        </div>
                        <div className="form-group">
                          <label htmlFor="memoryAutoSummarizeSchedule">Schedule (cron)</label>
                          <input
                            id="memoryAutoSummarizeSchedule"
                            type="text"
                            className="input"
                            value={memorySettingsDraft.memoryAutoSummarizeSchedule}
                            onChange={(event) => {
                              setMemorySettingsDraft((prev) => ({
                                ...prev,
                                memoryAutoSummarizeSchedule: event.target.value,
                              }));
                            }}
                            placeholder="0 3 * * *"
                            disabled={settingsLoading}
                          />
                          <small>Cron expression for auto-summarize schedule (default: daily at 3 AM)</small>
                        </div>
                      </>
                    )}
                  </div>

                  {!memorySettingsDraft.memoryEnabled && (
                    <div className="settings-empty-state memory-status-message">
                      Memory is currently disabled. Enable memory tools in Settings to edit these automations.
                    </div>
                  )}

                  {memorySettingsDirty && (
                    <div className="memory-action-bar">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={handleSaveMemorySettings}
                        disabled={savingMemorySettings || settingsLoading}
                      >
                        {savingMemorySettings ? (
                          <>
                            <Loader2 size={14} className="animate-spin" />
                            Saving…
                          </>
                        ) : (
                          "Save Settings"
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Insights Tab */}
        {activeTab === "insights" && (
          <div className="memory-insights-tab">
            {insightsLoading ? (
              <div className="memory-empty-state">
                <Loader2 size={20} className="animate-spin" />
                <span>Loading insights…</span>
              </div>
            ) : editingInsights ? (
              // Raw editor mode
              <>
                <div className="memory-editor-container">
                  <FileEditor
                    content={insightsEditorContent ?? ""}
                    onChange={setInsightsEditorContent}
                    readOnly={false}
                    filePath=".fusion/memory/INSIGHTS.md"
                  />
                </div>
                <div className="memory-action-bar">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCancelEditingInsights}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveInsights}
                  >
                    Save Insights
                  </button>
                </div>
              </>
            ) : !insightsExists || parsedCategories.length === 0 ? (
              // Empty state
              <div className="memory-empty-state">
                <p>No insights extracted yet.</p>
                <p>
                  Insights are automatically extracted from working memory.
                  Click &quot;Extract Now&quot; to trigger extraction manually.
                </p>
                <button
                  type="button"
                  className="btn btn-primary btn-sm memory-empty-extract-button"
                  onClick={handleExtractInsights}
                  disabled={extracting}
                >
                  {extracting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Extracting…
                    </>
                  ) : (
                    "Extract Now"
                  )}
                </button>
              </div>
            ) : (
              // Parsed insights view
              <>
                <div className="memory-stats-row">
                  <div className="memory-stat-card">
                    <div className="memory-stat-value">{totalInsights}</div>
                    <div className="memory-stat-label">Total Insights</div>
                  </div>
                  <div className="memory-stat-card">
                    <div className="memory-stat-value">{parsedCategories.length}</div>
                    <div className="memory-stat-label">Categories</div>
                  </div>
                  {lastUpdated && (
                    <div className="memory-stat-card">
                      <div className="memory-stat-value memory-stat-value--updated">{lastUpdated}</div>
                      <div className="memory-stat-label">Last Updated</div>
                    </div>
                  )}
                </div>

                <div className="memory-action-bar">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleExtractInsights}
                    disabled={extracting}
                  >
                    {extracting ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Extracting…
                      </>
                    ) : (
                      "Extract Now"
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleStartEditingInsights}
                  >
                    Edit Raw
                  </button>
                </div>

                <div className="memory-categories-list">
                  {parsedCategories.map((category) => {
                    const isExpanded = !expandedCategories.has(category.key);
                    return (
                      <div key={category.key} className="memory-category-section">
                        <div
                          className="memory-category-header"
                          onClick={() => toggleCategory(category.key)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              toggleCategory(category.key);
                            }
                          }}
                        >
                          <h4>{category.name}</h4>
                          <span className="memory-category-count">
                            {category.items.length}
                          </span>
                        </div>
                        {isExpanded && (
                          <div className="memory-category-items">
                            {category.items.map((item, index) => (
                              <div key={index} className="memory-insight-item">
                                {item.replace(/^-\s+/, "").replace(/^\*\s+/, "")}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* Engines Tab */}
        {activeTab === "engines" && (
          <div className="memory-engines-tab">
            {backendLoading || auditLoading ? (
              <div className="memory-empty-state">
                <Loader2 size={20} className="animate-spin" />
                <span>Loading engine status…</span>
              </div>
            ) : (
              <>
                {/* QMD Integration Card */}
                <div className="memory-engine-card memory-qmd-card">
                  <h3>QMD Integration</h3>
                  {backendStatus?.qmdAvailable === true ? (
                    <div className="memory-engine-status">
                      <span className="memory-health-badge memory-health-badge--healthy">Installed</span>
                      <span className="memory-char-count">qmd is available on PATH.</span>
                    </div>
                  ) : backendStatus?.qmdAvailable === false ? (
                    <div className="settings-empty-state memory-status-message">
                      <span>
                        qmd is not installed. Search will use local files. Install indexed retrieval: <code>{backendStatus.qmdInstallCommand || "bun install -g @tobilu/qmd"}</code>
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleInstallQmd}
                        disabled={installingQmd}
                      >
                        {installingQmd ? "Installing…" : "Install qmd"}
                      </button>
                    </div>
                  ) : (
                    <div className="memory-engine-status">
                      <span className="memory-health-badge">Checking</span>
                      <span className="memory-char-count">Checking qmd availability…</span>
                    </div>
                  )}
                  <div className="memory-capability-row">
                    {backendStatus?.capabilities?.readable && (
                      <span className="memory-capability-badge">Readable</span>
                    )}
                    {backendStatus?.capabilities?.writable && (
                      <span className="memory-capability-badge">Writable</span>
                    )}
                    {backendStatus?.capabilities?.supportsAtomicWrite && (
                      <span className="memory-capability-badge">Atomic Writes</span>
                    )}
                    {backendStatus?.capabilities?.persistent && (
                      <span className="memory-capability-badge">Persistent</span>
                    )}
                  </div>
                </div>

                {/* Memory Retrieval Test Card */}
                <div className="memory-engine-card memory-retrieval-card">
                  <h3>Test Memory Search</h3>
                  <div className="memory-retrieval-input-row">
                    <input
                      type="text"
                      className="input"
                      value={memoryTestQuery}
                      onChange={(event) => setMemoryTestQuery(event.target.value)}
                      placeholder="Search memory with qmd"
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleTestRetrieval}
                      disabled={memoryTestLoading}
                    >
                      {memoryTestLoading ? "Testing…" : "Test Retrieval"}
                    </button>
                  </div>
                  <small className="settings-muted">
                    Runs the same qmd-backed memory_search path agents use.
                  </small>

                  {memoryTestResult && (
                    <div className="memory-test-result">
                      <strong>
                        {memoryTestResult.results.length} result{memoryTestResult.results.length === 1 ? "" : "s"}
                        {" "}for "{memoryTestResult.query}"
                      </strong>
                      <small>
                        qmd {memoryTestResult.qmdAvailable ? "available" : "missing"} · {memoryTestResult.usedFallback ? "local fallback used" : "qmd path used"}
                      </small>
                      {memoryTestResult.results.length > 0 ? (
                        <ul>
                          {memoryTestResult.results.map((result, index) => (
                            <li key={`${result.path}-${result.lineStart}-${index}`}>
                              <span>{result.path}:{result.lineStart}</span>
                              <p>{result.snippet}</p>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <small>No matching memory found.</small>
                      )}
                    </div>
                  )}
                </div>

                {/* Backend Card */}
                <div className="memory-engine-card">
                  <h3>Current Backend</h3>
                  <div className="memory-engine-status">
                    <span className="memory-emphasis-text">{getBackendDisplayName(backendStatus?.currentBackend ?? "unknown")}</span>
                  </div>
                  <div className="memory-capability-row">
                    {backendStatus?.capabilities?.readable && (
                      <span className="memory-capability-badge">Readable</span>
                    )}
                    {backendStatus?.capabilities?.writable && (
                      <span className="memory-capability-badge">Writable</span>
                    )}
                    {backendStatus?.capabilities?.supportsAtomicWrite && (
                      <span className="memory-capability-badge">Atomic Writes</span>
                    )}
                    {backendStatus?.capabilities?.persistent && (
                      <span className="memory-capability-badge">Persistent</span>
                    )}
                  </div>
                </div>

                {/* Health Status Card */}
                {auditReport && (
                  <div className="memory-engine-card">
                    <div className="memory-health-header">
                      <h3>Health Status</h3>
                      <span className={`memory-health-badge memory-health-badge--${auditReport.health}`}>
                        {getHealthBadgeText(auditReport.health)}
                      </span>
                    </div>

                    <div className="memory-health-grid">
                      <div>
                        <div className="memory-health-label">Working Memory</div>
                        <div className="memory-emphasis-text">{auditReport.workingMemory.size} chars</div>
                        <div className="memory-health-detail">
                          {auditReport.workingMemory.sectionCount} sections
                        </div>
                      </div>
                      <div>
                        <div className="memory-health-label">Insights Memory</div>
                        <div className="memory-emphasis-text">{auditReport.insightsMemory.size} chars</div>
                        <div className="memory-health-detail">
                          {auditReport.insightsMemory.insightCount} insights
                        </div>
                      </div>
                    </div>

                    <div className="memory-health-section">
                      <div className="memory-health-label">Last Extraction</div>
                      <div className="memory-emphasis-text">
                        {auditReport.extraction.success ? (
                          <span className="memory-status-text memory-status-text--success">Success</span>
                        ) : (
                          <span className="memory-status-text memory-status-text--error">Failed</span>
                        )}
                      </div>
                      <div className="memory-health-detail">
                        {auditReport.extraction.summary || `${auditReport.extraction.insightCount} insights extracted`}
                      </div>
                    </div>

                    <div className="memory-health-section">
                      <div className="memory-health-label">Pruning</div>
                      <div className="memory-emphasis-text">
                        {auditReport.pruning.applied ? (
                          <span className="memory-status-text memory-status-text--warning">Applied</span>
                        ) : (
                          <span className="memory-status-text memory-status-text--muted">Not needed</span>
                        )}
                      </div>
                      {auditReport.pruning.applied && (
                        <div className="memory-health-detail">
                          {auditReport.pruning.reason}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Audit Checks */}
                {auditReport && auditReport.checks.length > 0 && (
                  <div className="memory-engine-card">
                    <h3>Audit Checks</h3>
                    <div>
                      {auditReport.checks.map((check) => (
                        <div key={check.id} className="memory-audit-check">
                          <span className={check.passed ? "memory-audit-check-passed" : "memory-audit-check-failed"}>
                            {check.passed ? "✓" : "✗"}
                          </span>
                          <div className="memory-audit-check-content">
                            <div className="memory-emphasis-text">{check.name}</div>
                            <div className="memory-health-detail">{check.details}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="memory-action-bar">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => refreshAudit()}
                  >
                    Run Audit
                  </button>
                </div>

                {/* Note about Settings */}
                <div className="memory-settings-note">
                  <span>Note: Change backend type in</span>
                  <button
                    type="button"
                    className="memory-settings-note-button"
                    onClick={() => {
                      // This would open the settings modal with memory section focused
                      // For now, just add a toast hint
                      addToast("Open Settings → Memory to change backend type", "info");
                    }}
                  >
                    Settings → Memory
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
