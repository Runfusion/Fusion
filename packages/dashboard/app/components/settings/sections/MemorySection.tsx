import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemoryBackendCapabilities, MemoryBackendStatus, MemoryFileInfo, MemoryRetrievalTestResult, } from "../../../api";
import { FileEditor } from "../../FileEditor";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps } from "./context";
import { LoadingSpinner } from "../../LoadingSpinner";
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
export interface MemorySectionMemoryProps {
    memoryCapabilities: MemoryBackendCapabilities | null;
    memoryBackendStatus: MemoryBackendStatus | null;
    memoryBackendLoading: boolean;
    memoryBackendError: string | null;
    memoryFiles: MemoryFileInfo[];
    selectedMemoryPath: string;
    setSelectedMemoryPath: (path: string) => void;
    memoryContent: string;
    setMemoryContent: (content: string) => void;
    memoryLoading: boolean;
    memoryDirty: boolean;
    setMemoryDirty: (dirty: boolean) => void;
    memoryTestQuery: string;
    setMemoryTestQuery: (query: string) => void;
    memoryTestLoading: boolean;
    memoryTestResult: MemoryRetrievalTestResult | null;
    qmdInstallLoading: boolean;
    dreamRunning: boolean;
    memoryCompactLoading: boolean;
    onInstallQmd: () => void;
    onTestMemoryRetrieval: () => void;
    onDreamNow: () => void;
    onCompactMemory: () => void;
    onSaveMemory: () => void;
}
export interface MemorySectionProps extends SectionBaseProps {
    memory: MemorySectionMemoryProps;
}
export function MemorySection({ form, setForm, memory }: MemorySectionProps) {
    const { t } = useTranslation("app");
    const { memoryCapabilities: capabilities, memoryBackendStatus: backendStatus, memoryBackendLoading: backendLoading, memoryBackendError: backendError, memoryFiles, selectedMemoryPath, setSelectedMemoryPath, memoryContent, setMemoryContent, memoryLoading, memoryDirty, setMemoryDirty, memoryTestQuery, setMemoryTestQuery, memoryTestLoading, memoryTestResult, qmdInstallLoading, dreamRunning, memoryCompactLoading, onInstallQmd, onTestMemoryRetrieval, onDreamNow, onCompactMemory, onSaveMemory, } = memory;
    // Determine if editing is allowed
    const isMemoryEnabled = form.memoryEnabled !== false;
    const backendStatusResolved = !backendLoading && backendStatus !== null;
    const isBackendWritable = backendStatusResolved ? (capabilities?.writable ?? true) : true;
    const isEditingAllowed = isMemoryEnabled && isBackendWritable;
    const selectedMemoryFile = memoryFiles.find((file) => file.path === selectedMemoryPath);
    const memoryLayerNames: Record<MemoryFileInfo["layer"], string> = {
        "long-term": "Long-term",
        daily: "Daily",
        dreams: "Dreams",
    };
    return (<>
      <h4 className="settings-section-heading">{t("settings.memory.memory", "Memory")}</h4>
      <div className="form-group">
        <small className="settings-muted">{t("settings.memory.memoryLivesIn", " Memory lives in ")}<code>.fusion/memory/</code>{t("settings.memory.agentsSearchWithQmdFirstFallBackTo", ". Agents search with qmd first, fall back to local files when qmd is missing, and open exact line windows only when needed. ")}</small>
      </div>

      <SettingsToggleRow
        descriptor={{
          key: "memoryEnabled",
          label: t("settings.memory.enableMemoryTools", " Enable memory tools "),
          help: t("settings.memory.agentsGetMemorySearchMemoryGetAndMemory", "Agents get memory_search, memory_get, and memory_append tools. Search defaults to qmd with a local file fallback. Default: enabled."),
          scope: "project",
        }}
        value={form.memoryEnabled !== false}
        onChange={(v) => setForm((f) => ({ ...f, memoryEnabled: v === true }))}
      />

      {backendLoading ? (<div className="form-group">
          <small className="settings-muted">{t("settings.memory.checkingMemoryWriteAccess", "Checking memory write access...")}</small>
        </div>) : backendError ? (<div className="form-group">
          <small className="field-error">{t("settings.memory.failedToLoadBackendStatus", "Failed to load backend status: ")}{backendError}</small>
        </div>) : null}

      {backendStatusResolved && backendStatus.qmdAvailable === false && (<div className="settings-empty-state memory-status-message">
          <span>{t("settings.memory.qmdIsNotInstalledSearchWillUseLocal", " qmd is not installed. Search will use local files. Install indexed retrieval: ")}<code>{backendStatus.qmdInstallCommand || "bun install -g @tobilu/qmd"}</code>
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onInstallQmd} disabled={qmdInstallLoading}>
            {qmdInstallLoading ? t("settings.memory.installing", "Installing…") : t("settings.memory.installQmd", "Install qmd")}
          </button>
        </div>)}

      <SettingsToggleRow
        descriptor={{
          key: "memoryAutoSummarizeEnabled",
          label: t("settings.memory.autoSummarizeMemory", " Auto-Summarize Memory "),
          help: t("settings.memory.automaticallyCompactMemoryWhenItExceedsTheThreshold", "Automatically compact memory when it exceeds the threshold on a schedule. Default: disabled."),
          scope: "project",
        }}
        value={form.memoryAutoSummarizeEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, memoryAutoSummarizeEnabled: v === true }))}
      />

      {(form.memoryAutoSummarizeEnabled || false) && (<>
          {/*
          FNXC:MemoryCompaction 2026-07-15-17:35:
          An empty or unparseable threshold falls back to the 50000 schema default rather than persisting undefined: the auto-summarize scheduler reads this value directly, so a blank field must still compact at the documented default instead of disabling compaction silently.
          */}
          <SettingsNumberRow
            descriptor={{
              key: "memoryAutoSummarizeThresholdChars",
              label: t("settings.memory.compactionThresholdChars", "Compaction Threshold (chars)"),
              help: t("settings.memory.memoryWillBeCompactedWhenItExceedsThis", "Memory will be compacted when it exceeds this character count. Default: 50000."),
              scope: "project",
              min: 1000,
            }}
            value={form.memoryAutoSummarizeThresholdChars ?? 50000}
            onChange={(v) => setForm((f) => ({ ...f, memoryAutoSummarizeThresholdChars: v || 50000 }))}
          />
          <SettingsTextRow
            descriptor={{
              key: "memoryAutoSummarizeSchedule",
              label: t("settings.memory.scheduleCron", "Schedule (cron)"),
              help: t("settings.memory.cronExpressionForAutoSummarizeScheduleDefaultDaily", "Cron expression for auto-summarize schedule. Default: 0 3 * * * (daily at 3 AM)."),
              scope: "project",
              placeholder: t("settings.memory.03", "0 3 * * *"),
            }}
            value={form.memoryAutoSummarizeSchedule ?? "0 3 * * *"}
            onChange={(v) => setForm((f) => ({ ...f, memoryAutoSummarizeSchedule: v ?? "" }))}
          />
        </>)}

      <SettingsToggleRow
        descriptor={{
          key: "insightExtractionEnabled",
          label: t("settings.memory.enableInsightExtraction", " Enable Insight Extraction "),
          help: t("settings.memory.periodicallyExtractDurableInsightsFromCompletedTasks", "Periodically extract durable insights/learnings from completed tasks into memory"),
          scope: "project",
        }}
        value={form.insightExtractionEnabled || false}
        onChange={(v) => setForm((f) => ({ ...f, insightExtractionEnabled: v === true }))}
      />

      {(form.insightExtractionEnabled || false) && (
          <SettingsTextRow
            descriptor={{
              key: "insightExtractionSchedule",
              label: t("settings.memory.scheduleCron", "Schedule (cron)"),
              help: t("settings.memory.cronExpressionForInsightExtractionScheduleDefaultDaily", "Cron expression for insight extraction schedule (default: daily at 2 AM)"),
              scope: "project",
              placeholder: t("settings.memory.02", "0 2 * * *"),
            }}
            value={form.insightExtractionSchedule ?? "0 2 * * *"}
            onChange={(v) => setForm((f) => ({ ...f, insightExtractionSchedule: v ?? "" }))}
          />)}

      <div style={{ borderTop: "1px solid var(--border)", margin: "var(--space-lg) 0" }}/>

      {/*
      FNXC:MemoryDreams 2026-07-15-17:35:
      Dream processing reads the daily memory layer, so the toggle is disabled whenever memory tools are off — there is nothing to synthesize from. The schedule row below stays gated on both flags for the same reason.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "memoryDreamsEnabled",
          label: t("settings.memory.processDreamsFromDailyMemory", " Process dreams from daily memory "),
          help: t("settings.memory.turnsDailyNotesIntoDREAMSMdAndPromotes", "Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md. Default: disabled."),
          scope: "project",
          disabled: !isMemoryEnabled,
        }}
        value={form.memoryDreamsEnabled === true}
        onChange={(v) => setForm((f) => ({ ...f, memoryDreamsEnabled: v === true }))}
      />

      {isMemoryEnabled && form.memoryDreamsEnabled === true && (<>
          <SettingsTextRow
            descriptor={{
              key: "memoryDreamsSchedule",
              label: t("settings.memory.dreamSchedule", "Dream Schedule"),
              help: t("settings.memory.cronExpressionForDreamProcessing", "Cron expression for dream processing. Default: 0 4 * * * (daily at 4 AM)."),
              scope: "project",
            }}
            value={form.memoryDreamsSchedule ?? "0 4 * * *"}
            onChange={(v) => setForm((f) => ({ ...f, memoryDreamsSchedule: v ?? "" }))}
          />
          <div className="form-group">
            <button type="button" className="btn btn-sm" onClick={onDreamNow} disabled={dreamRunning || form.memoryDreamsEnabled !== true}>
              {dreamRunning ? (<>
                  <Loader2 size={14} className="animate-spin"/>{t("settings.memory.dreaming", " Dreaming\u2026 ")}</>) : (t("settings.memory.dreamNow", "Dream Now"))}
            </button>
            <small>{t("settings.memory.manuallyTriggerDreamProcessingNow", "Manually trigger dream processing now.")}</small>
          </div>
        </>)}

      {/*
      FNXC:SettingsSearch 2026-07-15-17:35:
      The retrieval tester, memory-file picker, and editor below stay on plain `form-group` markup on purpose: none of them edits a settings key. They are a transient query box, a file selector gated on unsaved edits, and a document editor, so rendering them as settings rows would file them in the settings search index as configuration an operator can set — which they are not.
      */}
      <div className="memory-retrieval-test">
        <div className="form-group">
          <label htmlFor="memoryRetrievalQuery">{t("settings.memory.testRetrieval", "Test Retrieval")}</label>
          <input id="memoryRetrievalQuery" type="text" value={memoryTestQuery} onChange={(e) => setMemoryTestQuery(e.target.value)} placeholder={t("settings.memory.searchMemoryWithQmd", "Search memory with qmd")}/>
          <small>{t("settings.memory.runsTheSameQmdBackedMemorySearchPath", "Runs the same qmd-backed memory_search path agents use.")}</small>
        </div>
        <div className="form-group">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onTestMemoryRetrieval} disabled={memoryTestLoading}>
            {memoryTestLoading ? t("settings.memory.testing", "Testing…") : t("settings.memory.testRetrieval", "Test Retrieval")}
          </button>
        </div>
        {memoryTestResult && (<div className="memory-test-result">
            <strong>
              {memoryTestResult.results.length}{t("settings.memory.result", " result")}{memoryTestResult.results.length === 1 ? "" : "s"}
              {" "}{t("settings.memory.for", "for \"")}{memoryTestResult.query}"
            </strong>
            <small>{t("settings.memory.qmd", " qmd ")}{memoryTestResult.qmdAvailable ? "available" : "missing"} · {memoryTestResult.usedFallback ? "local fallback used" : "qmd path used"}
            </small>
            {memoryTestResult.results.length > 0 ? (<ul>
                {memoryTestResult.results.map((result, index) => (<li key={`${result.path}-${result.lineStart}-${index}`}>
                    <span>{result.path}:{result.lineStart}</span>
                    <p>{result.snippet}</p>
                  </li>))}
              </ul>) : (<small>{t("settings.memory.noMatchingMemoryFound", "No matching memory found.")}</small>)}
          </div>)}
      </div>

      {!isMemoryEnabled && (<div className="settings-empty-state memory-status-message">{t("settings.memory.memoryIsCurrentlyDisabledYouCanViewThe", " Memory is currently disabled. You can view the file, but editing is read-only until memory is re-enabled. ")}</div>)}
      {isMemoryEnabled && backendStatusResolved && !isBackendWritable && (<div className="settings-empty-state memory-status-message">{t("settings.memory.memoryIsConfiguredWithAReadOnlyBackend", " Memory is configured with a read-only backend. You can view the file, but saving is disabled. ")}</div>)}

      {memoryLoading ? (<div className="settings-empty-state"><LoadingSpinner label={t("settings.memory.loadingMemory", "Loading memory\u2026")} /></div>) : (<div className="memory-editor-section">
          <div className="form-group">
            <label htmlFor="memoryFilePath">{t("settings.memory.memoryFile", "Memory File")}</label>
            <select id="memoryFilePath" value={selectedMemoryPath} onChange={(e) => {
                setSelectedMemoryPath(e.target.value);
                setMemoryDirty(false);
            }} disabled={memoryDirty}>
              {memoryFiles.map((file) => (<option key={file.path} value={file.path} title={`${file.label} — ${file.path}`}>
                  {formatMemoryFileOptionLabel(file)}
                </option>))}
            </select>
            <small>
              {memoryDirty
                ? "Save or discard the current edits before switching files."
                : "Choose any project memory file to view or edit. Dreams is selected by default."}
            </small>
          </div>
          {selectedMemoryFile && (<div className="memory-file-summary">
              <span>{memoryLayerNames[selectedMemoryFile.layer]}</span>
              <strong>{selectedMemoryFile.path}</strong>
              <small>
                {selectedMemoryFile.size.toLocaleString()}{t("settings.memory.bytesUpdated", " bytes \u00B7 updated ")}{new Date(selectedMemoryFile.updatedAt).toLocaleString()}
              </small>
            </div>)}
          <div className="form-group memory-editor-form-group">
            <label>{selectedMemoryFile?.label || "Memory Editor"}</label>
            <small>
              {selectedMemoryFile?.layer === "long-term" && "Curated durable decisions, conventions, constraints, and pitfalls promoted from dreams."}
              {selectedMemoryFile?.layer === "daily" && "Raw daily observations, open loops, and running context for dream processing."}
              {selectedMemoryFile?.layer === "dreams" && "Synthesized patterns and open loops promoted from daily memory."}
              {!selectedMemoryFile && "Edits the selected memory file."}
            </small>
            <div className="memory-editor-frame">
              <FileEditor content={memoryContent} onChange={(content) => {
                setMemoryContent(content);
                setMemoryDirty(true);
            }} readOnly={!isEditingAllowed} filePath={selectedMemoryPath}/>
            </div>
          </div>
        </div>)}

      {!memoryLoading && (<div className="form-group">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCompactMemory} disabled={!isEditingAllowed || memoryDirty || memoryCompactLoading}>
            {memoryCompactLoading ? t("settings.memory.compacting", "Compacting…") : t("settings.memory.compactSelectedFile", "Compact Selected File")}
          </button>
          <small>
            {memoryDirty
                ? "Save or discard edits before compacting this file."
                : `Compacts ${selectedMemoryPath} and writes the result back to the same file.`}
          </small>
        </div>)}

      {memoryDirty && isEditingAllowed && (<div className="form-group">
          <button type="button" className="btn btn-primary btn-sm" onClick={onSaveMemory}>
            {t("settings.memory.saveMemory", "Save Memory")}
          </button>
        </div>)}
      {memoryDirty && !isEditingAllowed && (<div className="form-group">
          <small className="field-error">{t("settings.memory.cannotSave", "Cannot save: ")}{isMemoryEnabled ? "Backend is read-only" : "Memory is disabled"}</small>
        </div>)}
    </>);
}
export default MemorySection;
