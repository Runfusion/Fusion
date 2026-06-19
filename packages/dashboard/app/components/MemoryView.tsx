import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import "./MemoryView.css";
import "./SettingsModal.css";
import type { MemoryFileInfo, MemoryRetrievalTestResult } from "../api";
import { FileEditor } from "./FileEditor";
import { useMemoryData } from "../hooks/useMemoryData";

interface MemoryViewProps {
  projectId?: string;
  addToast: (message: string, type: "success" | "error" | "info") => void;
  onSendSelectionToTask?: (description: string) => void;
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

const MEMORY_FILE_OPTION_LABEL_MAX_CHARS = 72;

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const visibleChars = Math.max(1, maxChars - 1);
  const startChars = Math.ceil(visibleChars / 2);
  const endChars = Math.floor(visibleChars / 2);
  return `${value.slice(0, startChars)}…${value.slice(value.length - endChars)}`;
}

function formatMemoryFileOptionLabel(file: MemoryFileInfo): string {
  const fullLabel = `${file.label} — ${file.path}`;
  return truncateMiddle(fullLabel, MEMORY_FILE_OPTION_LABEL_MAX_CHARS);
}

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

export function MemoryView({ projectId, addToast, onSendSelectionToTask }: MemoryViewProps) {
  const { t } = useTranslation("app");
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
    ? (selectedMemoryFile.layer === "long-term"
        ? t("memory.layerDescLongTerm", "Curated durable decisions, conventions, constraints, and pitfalls promoted from dreams.")
        : selectedMemoryFile.layer === "daily"
          ? t("memory.layerDescDaily", "Raw daily observations, open loops, and running context for dream processing.")
          : t("memory.layerDescDreams", "Synthesized patterns and open loops promoted from daily memory."))
    : t("memory.editorDefaultDescription", "Edits the selected memory file.");

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
      addToast(t("memory.loadFileFailed", "Failed to load memory file"), "error");
    }
  }, [selectFile, addToast]);

  const handleSaveSelectedFile = useCallback(async () => {
    try {
      await saveSelectedFile();
      addToast(t("memory.memorySaved", "Memory saved"), "success");
    } catch {
      addToast(t("memory.saveMemoryFailed", "Failed to save memory"), "error");
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
      addToast(t("memory.settingsSaved", "Memory settings saved"), "success");
    } catch {
      addToast(t("memory.saveSettingsFailed", "Failed to save memory settings"), "error");
    }
  }, [memorySettingsDirty, memorySettingsDraft, memorySettings, saveMemorySettings, addToast]);

  const handleInstallQmd = useCallback(async () => {
    try {
      const result = await installQmdAction();
      addToast(
        result.qmdAvailable ? t("memory.qmdInstallSuccess", "qmd installed successfully") : t("memory.qmdInstallUnavailable", "qmd install finished, but qmd is still unavailable"),
        result.qmdAvailable ? "success" : "info",
      );
    } catch {
      addToast(t("memory.installQmdFailed", "Failed to install qmd"), "error");
    }
  }, [installQmdAction, addToast]);

  const handleTestRetrieval = useCallback(async () => {
    setMemoryTestLoading(true);
    setMemoryTestResult(null);

    try {
      const result = await testRetrieval(memoryTestQuery);
      setMemoryTestResult(result);
      addToast(
        result.qmdAvailable ? t("memory.retrievalTestComplete", "Memory retrieval test complete") : t("memory.retrievalTestFallback", "qmd is not installed; local fallback was used"),
        result.qmdAvailable ? "success" : "info",
      );
    } catch {
      addToast(t("memory.retrievalTestFailed", "Failed to test memory retrieval"), "error");
    } finally {
      setMemoryTestLoading(false);
    }
  }, [memoryTestQuery, testRetrieval, addToast]);

  const handleDreamNow = useCallback(async () => {
    try {
      await triggerDreamNow();
      addToast(t("memory.dreamProcessingComplete", "Dream processing completed"), "success");
      await reloadMemoryFiles();
    } catch (error) {
      addToast(error instanceof Error ? error.message : t("memory.dreamProcessingFailed", "Failed to run dream processing"), "error");
    }
  }, [triggerDreamNow, reloadMemoryFiles, addToast]);

  // Handle compact memory
  const handleCompactMemory = useCallback(async () => {
    try {
      await compactMemory(selectedFilePath);
      addToast(t("memory.fileCompacted", "Memory file compacted"), "success");
    } catch {
      addToast(t("memory.compactFailed", "Failed to compact memory"), "error");
    }
  }, [compactMemory, selectedFilePath, addToast]);

  // Handle extract insights
  const handleExtractInsights = useCallback(async () => {
    try {
      const result = await extractInsights();
      addToast(result.summary, "success");
    } catch (err) {
      addToast(err instanceof Error ? err.message : t("memory.extractInsightsFailed", "Failed to extract insights"), "error");
    }
  }, [extractInsights, addToast]);

  // Handle save insights (from raw editor)
  const handleSaveInsights = useCallback(async () => {
    if (insightsEditorContent === null) return;
    try {
      await saveInsights(insightsEditorContent);
      setEditingInsights(false);
      setInsightsEditorContent(null);
      addToast(t("memory.insightsSaved", "Insights saved"), "success");
    } catch {
      addToast(t("memory.saveInsightsFailed", "Failed to save insights"), "error");
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
          <h2>{t("memory.title", "Memory")}</h2>
          <p className="memory-view-description">
            {t("memory.description", "Working memory, long-term insights, and engine status")}
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
          {t("memory.tabWorking", "Working Memory")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "insights"}
          className={`memory-view-tab${activeTab === "insights" ? " memory-view-tab--active" : ""}`}
          onClick={() => setActiveTab("insights")}
          data-testid="memory-tab-insights"
        >
          {t("memory.tabInsights", "Insights")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "engines"}
          className={`memory-view-tab${activeTab === "engines" ? " memory-view-tab--active" : ""}`}
          onClick={() => setActiveTab("engines")}
          data-testid="memory-tab-engines"
        >
          {t("memory.tabEngines", "Engines")}
        </button>
      </div>

      {/* Content area */}
      <div className="memory-view-content">
        {/* Working Memory Tab */}
        {activeTab === "working" && (
          <div className="memory-working-tab">
            {backendStatusResolved && !isWritable && (
              <div className="memory-readonly-banner">
                {t("memory.readOnlyBanner", "This memory backend is read-only. Changes cannot be saved.")}
              </div>
            )}

            {memoryFilesLoading || selectedFileLoading ? (
              <div className="memory-empty-state">
                <Loader2 size={20} className="animate-spin" />
                <span>{t("memory.loadingFile", "Loading memory file…")}</span>
              </div>
            ) : (
              <>
                <div className="memory-editor-section">
                  <div className="form-group">
                    <label htmlFor="memoryViewFilePath">{t("memory.fileLabel", "Memory File")}</label>
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
                        <option key={file.path} value={file.path} title={`${file.label} — ${file.path}`}>
                          {formatMemoryFileOptionLabel(file)}
                        </option>
                      ))}
                    </select>
                    <small>
                      {selectedFileDirty
                        ? t("memory.fileSwitchDirtyHint", "Save or discard the current edits before switching files.")
                        : t("memory.fileSwitchHint", "Choose any project memory file to view or edit.")}
                    </small>
                  </div>

                  {selectedMemoryFile && (
                    <div className="memory-file-summary">
                      <span>{selectedMemoryFile.layer === "long-term" ? t("memory.layerLongTerm", "Long-term") : selectedMemoryFile.layer === "daily" ? t("memory.layerDaily", "Daily") : t("memory.layerDreams", "Dreams")}</span>
                      <strong>{selectedMemoryFile.path}</strong>
                      <small>
                        {t("memory.fileSummary", "{{size}} bytes · updated {{updatedAt}}", { size: selectedMemoryFile.size.toLocaleString(), updatedAt: new Date(selectedMemoryFile.updatedAt).toLocaleString() })}
                      </small>
                    </div>
                  )}

                  <div className="form-group memory-editor-form-group">
                    <label>{selectedMemoryFile?.label || t("memory.editorLabel", "Memory Editor")}</label>
                    <small>{selectedLayerDescription}</small>
                    <div className="memory-editor-container">
                      <FileEditor
                        content={selectedFileContent}
                        onChange={setSelectedFileContent}
                        readOnly={!isWritable}
                        filePath={selectedFilePath}
                        onSendSelectionToTask={onSendSelectionToTask}
                      />
                    </div>
                  </div>
                </div>

                <div className="memory-action-bar">
                  <span className="memory-char-count">{t("memory.charCount", "{{count}} characters", { count: selectedFileContent.length })}</span>
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
                          {t("memory.compacting", "Compacting…")}
                        </>
                      ) : (
                        t("memory.compactSelectedFile", "Compact Selected File")
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
                          {t("memory.saving", "Saving…")}
                        </>
                      ) : (
                        t("memory.save", "Save")
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
                        {t("memory.dreamsEnabledLabel", "Process dreams from daily memory")}
                      </label>
                      <small>{t("memory.dreamsEnabledHint", "Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md.")}</small>
                    </div>

                    {memorySettingsDraft.memoryEnabled && memorySettingsDraft.memoryDreamsEnabled && (
                      <>
                        <div className="form-group">
                          <label htmlFor="memoryDreamsSchedule">{t("memory.dreamsScheduleLabel", "Dream Schedule")}</label>
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
                          <small>{t("memory.dreamsScheduleHint", "Cron expression for dream processing.")}</small>
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
                                {t("memory.dreaming", "Dreaming…")}
                              </>
                            ) : (
                              t("memory.dreamNow", "Dream Now")
                            )}
                          </button>
                          <small>{t("memory.dreamNowHint", "Manually trigger dream processing now.")}</small>
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
                        {t("memory.autoSummarizeLabel", "Auto-Summarize Memory")}
                      </label>
                      <small>{t("memory.autoSummarizeHint", "Automatically compact memory when it exceeds the threshold on a schedule")}</small>
                    </div>

                    {memorySettingsDraft.memoryEnabled && memorySettingsDraft.memoryAutoSummarizeEnabled && (
                      <>
                        <div className="form-group">
                          <label htmlFor="memoryAutoSummarizeThresholdChars">{t("memory.compactionThresholdLabel", "Compaction Threshold (chars)")}</label>
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
                          <small>{t("memory.compactionThresholdHint", "Memory will be compacted when it exceeds this character count")}</small>
                        </div>
                        <div className="form-group">
                          <label htmlFor="memoryAutoSummarizeSchedule">{t("memory.autoSummarizeScheduleLabel", "Schedule (cron)")}</label>
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
                          <small>{t("memory.autoSummarizeScheduleHint", "Cron expression for auto-summarize schedule (default: daily at 3 AM)")}</small>
                        </div>
                      </>
                    )}
                  </div>

                  {!memorySettingsDraft.memoryEnabled && (
                    <div className="settings-empty-state memory-status-message">
                      {t("memory.disabledMessage", "Memory is currently disabled. Enable memory tools in Settings to edit these automations.")}
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
                            {t("memory.saving", "Saving…")}
                          </>
                        ) : (
                          t("memory.saveSettings", "Save Settings")
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
                <span>{t("memory.loadingInsights", "Loading insights…")}</span>
              </div>
            ) : editingInsights ? (
              // Raw editor mode
              <div className="memory-insights-editor-layout">
                <div className="memory-editor-container">
                  <FileEditor
                    content={insightsEditorContent ?? ""}
                    onChange={setInsightsEditorContent}
                    readOnly={false}
                    filePath=".fusion/memory/INSIGHTS.md"
                    onSendSelectionToTask={onSendSelectionToTask}
                  />
                </div>
                <div className="memory-action-bar">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleCancelEditingInsights}
                  >
                    {t("memory.cancel", "Cancel")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveInsights}
                  >
                    {t("memory.saveInsights", "Save Insights")}
                  </button>
                </div>
              </div>
            ) : !insightsExists || parsedCategories.length === 0 ? (
              // Empty state
              <div className="memory-empty-state">
                <p>{t("memory.noInsights", "No insights extracted yet.")}</p>
                <p>
                  {t("memory.noInsightsHint", "Insights are automatically extracted from working memory. Click \"Extract Now\" to trigger extraction manually.")}
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
                      {t("memory.extracting", "Extracting…")}
                    </>
                  ) : (
                    t("memory.extractNow", "Extract Now")
                  )}
                </button>
              </div>
            ) : (
              // Parsed insights view
              <>
                <div className="memory-stats-row">
                  <div className="memory-stat-card">
                    <div className="memory-stat-value">{totalInsights}</div>
                    <div className="memory-stat-label">{t("memory.totalInsights", "Total Insights")}</div>
                  </div>
                  <div className="memory-stat-card">
                    <div className="memory-stat-value">{parsedCategories.length}</div>
                    <div className="memory-stat-label">{t("memory.categories", "Categories")}</div>
                  </div>
                  {lastUpdated && (
                    <div className="memory-stat-card">
                      <div className="memory-stat-value memory-stat-value--updated">{lastUpdated}</div>
                      <div className="memory-stat-label">{t("memory.lastUpdated", "Last Updated")}</div>
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
                        {t("memory.extracting", "Extracting…")}
                      </>
                    ) : (
                      t("memory.extractNow", "Extract Now")
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={handleStartEditingInsights}
                  >
                    {t("memory.editRaw", "Edit Raw")}
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
                <span>{t("memory.loadingEngineStatus", "Loading engine status…")}</span>
              </div>
            ) : (
              <>
                {/* QMD Integration Card */}
                <div className="memory-engine-card memory-qmd-card">
                  <h3>{t("memory.qmdIntegrationTitle", "QMD Integration")}</h3>
                  {backendStatus?.qmdAvailable === true ? (
                    <div className="memory-engine-status">
                      <span className="memory-health-badge memory-health-badge--healthy">{t("memory.qmdInstalled", "Installed")}</span>
                      <span className="memory-char-count">{t("memory.qmdAvailableOnPath", "qmd is available on PATH.")}</span>
                    </div>
                  ) : backendStatus?.qmdAvailable === false ? (
                    <div className="settings-empty-state memory-status-message">
                      <span>
                        {t("memory.qmdNotInstalled", "qmd is not installed. Search will use local files. Install indexed retrieval:")} <code>{backendStatus.qmdInstallCommand || "bun install -g @tobilu/qmd"}</code>
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handleInstallQmd}
                        disabled={installingQmd}
                      >
                        {installingQmd ? t("memory.installing", "Installing…") : t("memory.installQmd", "Install qmd")}
                      </button>
                    </div>
                  ) : (
                    <div className="memory-engine-status">
                      <span className="memory-health-badge">{t("memory.qmdChecking", "Checking")}</span>
                      <span className="memory-char-count">{t("memory.qmdCheckingAvailability", "Checking qmd availability…")}</span>
                    </div>
                  )}
                  <div className="memory-capability-row">
                    {backendStatus?.capabilities?.readable && (
                      <span className="memory-capability-badge">{t("memory.capReadable", "Readable")}</span>
                    )}
                    {backendStatus?.capabilities?.writable && (
                      <span className="memory-capability-badge">{t("memory.capWritable", "Writable")}</span>
                    )}
                    {backendStatus?.capabilities?.supportsAtomicWrite && (
                      <span className="memory-capability-badge">{t("memory.capAtomicWrites", "Atomic Writes")}</span>
                    )}
                    {backendStatus?.capabilities?.persistent && (
                      <span className="memory-capability-badge">{t("memory.capPersistent", "Persistent")}</span>
                    )}
                  </div>
                </div>

                {/* Memory Retrieval Test Card */}
                <div className="memory-engine-card memory-retrieval-card">
                  <h3>{t("memory.testMemorySearchTitle", "Test Memory Search")}</h3>
                  <div className="memory-retrieval-input-row">
                    <input
                      type="text"
                      className="input"
                      value={memoryTestQuery}
                      onChange={(event) => setMemoryTestQuery(event.target.value)}
                      placeholder={t("memory.searchPlaceholder", "Search memory with qmd")}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={handleTestRetrieval}
                      disabled={memoryTestLoading}
                    >
                      {memoryTestLoading ? t("memory.testing", "Testing…") : t("memory.testRetrieval", "Test Retrieval")}
                    </button>
                  </div>
                  <small className="settings-muted">
                    {t("memory.testSearchHint", "Runs the same qmd-backed memory_search path agents use.")}
                  </small>

                  {memoryTestResult && (
                    <div className="memory-test-result">
                      <strong>
                        {t("memory.testResultCount", "{{count}} result for \"{{query}}\"", { count: memoryTestResult.results.length, query: memoryTestResult.query, defaultValue_one: "{{count}} result for \"{{query}}\"", defaultValue_other: "{{count}} results for \"{{query}}\"" })}
                      </strong>
                      <small>
                        {t("memory.testResultStatus", "qmd {{qmdStatus}} · {{fallbackStatus}}", { qmdStatus: memoryTestResult.qmdAvailable ? t("memory.qmdStatusAvailable", "available") : t("memory.qmdStatusMissing", "missing"), fallbackStatus: memoryTestResult.usedFallback ? t("memory.localFallbackUsed", "local fallback used") : t("memory.qmdPathUsed", "qmd path used") })}
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
                        <small>{t("memory.noMatchingMemory", "No matching memory found.")}</small>
                      )}
                    </div>
                  )}
                </div>

                {/* Backend Card */}
                <div className="memory-engine-card">
                  <h3>{t("memory.currentBackendTitle", "Current Backend")}</h3>
                  <div className="memory-engine-status">
                    <span className="memory-emphasis-text">{
                      backendStatus?.currentBackend === "file"
                        ? t("memory.backendFile", "File (.fusion/memory/, agent/<agent-name>/memory/)")
                        : backendStatus?.currentBackend === "readonly"
                          ? t("memory.backendReadonly", "Read-Only")
                          : backendStatus?.currentBackend === "qmd"
                            ? t("memory.backendQmd", "QMD (Quantized Memory Distillation)")
                            : (backendStatus?.currentBackend ?? "unknown")
                    }</span>
                  </div>
                  <div className="memory-capability-row">
                    {backendStatus?.capabilities?.readable && (
                      <span className="memory-capability-badge">{t("memory.capReadable", "Readable")}</span>
                    )}
                    {backendStatus?.capabilities?.writable && (
                      <span className="memory-capability-badge">{t("memory.capWritable", "Writable")}</span>
                    )}
                    {backendStatus?.capabilities?.supportsAtomicWrite && (
                      <span className="memory-capability-badge">{t("memory.capAtomicWrites", "Atomic Writes")}</span>
                    )}
                    {backendStatus?.capabilities?.persistent && (
                      <span className="memory-capability-badge">{t("memory.capPersistent", "Persistent")}</span>
                    )}
                  </div>
                </div>

                {/* Health Status Card */}
                {auditReport && (
                  <div className="memory-engine-card">
                    <div className="memory-health-header">
                      <h3>{t("memory.healthStatusTitle", "Health Status")}</h3>
                      <span className={`memory-health-badge memory-health-badge--${auditReport.health}`}>
                        {auditReport.health === "healthy" ? t("memory.healthHealthy", "Healthy") : auditReport.health === "warning" ? t("memory.healthWarning", "Warning") : t("memory.healthIssues", "Issues Found")}
                      </span>
                    </div>

                    <div className="memory-health-grid">
                      <div>
                        <div className="memory-health-label">{t("memory.workingMemoryLabel", "Working Memory")}</div>
                        <div className="memory-emphasis-text">{t("memory.sizeChars", "{{size}} chars", { size: auditReport.workingMemory.size })}</div>
                        <div className="memory-health-detail">
                          {t("memory.sectionCount", "{{count}} sections", { count: auditReport.workingMemory.sectionCount })}
                        </div>
                      </div>
                      <div>
                        <div className="memory-health-label">{t("memory.insightsMemoryLabel", "Insights Memory")}</div>
                        <div className="memory-emphasis-text">{t("memory.sizeChars", "{{size}} chars", { size: auditReport.insightsMemory.size })}</div>
                        <div className="memory-health-detail">
                          {t("memory.insightCount", "{{count}} insights", { count: auditReport.insightsMemory.insightCount })}
                        </div>
                      </div>
                    </div>

                    <div className="memory-health-section">
                      <div className="memory-health-label">{t("memory.lastExtractionLabel", "Last Extraction")}</div>
                      <div className="memory-emphasis-text">
                        {auditReport.extraction.success ? (
                          <span className="memory-status-text memory-status-text--success">{t("memory.extractionSuccess", "Success")}</span>
                        ) : (
                          <span className="memory-status-text memory-status-text--error">{t("memory.extractionFailed", "Failed")}</span>
                        )}
                      </div>
                      <div className="memory-health-detail">
                        {auditReport.extraction.summary || t("memory.insightsExtracted", "{{count}} insights extracted", { count: auditReport.extraction.insightCount })}
                      </div>
                    </div>

                    <div className="memory-health-section">
                      <div className="memory-health-label">{t("memory.pruningLabel", "Pruning")}</div>
                      <div className="memory-emphasis-text">
                        {auditReport.pruning.applied ? (
                          <span className="memory-status-text memory-status-text--warning">{t("memory.pruningApplied", "Applied")}</span>
                        ) : (
                          <span className="memory-status-text memory-status-text--muted">{t("memory.pruningNotNeeded", "Not needed")}</span>
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
                    <h3>{t("memory.auditChecksTitle", "Audit Checks")}</h3>
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
                    {t("memory.runAudit", "Run Audit")}
                  </button>
                </div>

                {/* Note about Settings */}
                <div className="memory-settings-note">
                  <span>{t("memory.settingsNote", "Note: Change backend type in")}</span>
                  <button
                    type="button"
                    className="memory-settings-note-button"
                    onClick={() => {
                      // This would open the settings modal with memory section focused
                      // For now, just add a toast hint
                      addToast(t("memory.settingsNoteToast", "Open Settings → Memory to change backend type"), "info");
                    }}
                  >
                    {t("memory.settingsNoteLink", "Settings → Memory")}
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
