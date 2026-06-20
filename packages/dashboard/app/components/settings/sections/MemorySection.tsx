import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MemoryBackendCapabilities, MemoryBackendStatus, MemoryFileInfo, MemoryRetrievalTestResult, } from "../../../api";
import { FileEditor } from "../../FileEditor";
import type { SectionBaseProps } from "./context";
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
    scopeBanner: ReactNode;
    memory: MemorySectionMemoryProps;
}
export function MemorySection({ scopeBanner, form, setForm, memory }: MemorySectionProps) {
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
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.memory.memory", "Memory")}</h4>
      <div className="form-group">
        <small className="settings-muted">{t("settings.memory.memoryLivesIn", " Memory lives in ")}<code>.fusion/memory/</code>{t("settings.memory.agentsSearchWithQmdFirstFallBackTo", ". Agents search with qmd first, fall back to local files when qmd is missing, and open exact line windows only when needed. ")}</small>
      </div>

      <div className="form-group">
        <label htmlFor="memoryEnabled" className="checkbox-label">
          <input id="memoryEnabled" type="checkbox" checked={form.memoryEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, memoryEnabled: e.target.checked }))}/>{t("settings.memory.enableMemoryTools", " Enable memory tools ")}</label>
        <small>{t("settings.memory.agentsGetMemorySearchMemoryGetAndMemory", "Agents get memory_search, memory_get, and memory_append tools. Search defaults to qmd with a local file fallback.")}</small>
      </div>

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

      <div className="form-group">
        <label htmlFor="memoryAutoSummarizeEnabled" className="checkbox-label">
          <input id="memoryAutoSummarizeEnabled" type="checkbox" checked={form.memoryAutoSummarizeEnabled || false} onChange={(e) => setForm((f) => ({ ...f, memoryAutoSummarizeEnabled: e.target.checked }))}/>{t("settings.memory.autoSummarizeMemory", " Auto-Summarize Memory ")}</label>
        <small>{t("settings.memory.automaticallyCompactMemoryWhenItExceedsTheThreshold", "Automatically compact memory when it exceeds the threshold on a schedule")}</small>
      </div>

      {(form.memoryAutoSummarizeEnabled || false) && (<>
          <div className="form-group">
            <label htmlFor="memoryAutoSummarizeThresholdChars">{t("settings.memory.compactionThresholdChars", "Compaction Threshold (chars)")}</label>
            <input id="memoryAutoSummarizeThresholdChars" type="number" className="input" value={form.memoryAutoSummarizeThresholdChars ?? 50000} onChange={(e) => setForm((f) => ({
                ...f,
                memoryAutoSummarizeThresholdChars: parseInt(e.target.value, 10) || 50000,
            }))} min={1000}/>
            <small>{t("settings.memory.memoryWillBeCompactedWhenItExceedsThis", "Memory will be compacted when it exceeds this character count")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="memoryAutoSummarizeSchedule">{t("settings.memory.scheduleCron", "Schedule (cron)")}</label>
            <input id="memoryAutoSummarizeSchedule" type="text" className="input" value={form.memoryAutoSummarizeSchedule ?? "0 3 * * *"} onChange={(e) => setForm((f) => ({ ...f, memoryAutoSummarizeSchedule: e.target.value }))} placeholder={t("settings.memory.03", "0 3 * * *")}/>
            <small>{t("settings.memory.cronExpressionForAutoSummarizeScheduleDefaultDaily", "Cron expression for auto-summarize schedule (default: daily at 3 AM)")}</small>
          </div>
        </>)}

      <div style={{ borderTop: "1px solid var(--border)", margin: "var(--space-lg) 0" }}/>

      <div className="form-group">
        <label htmlFor="memoryDreamsEnabled" className="checkbox-label">
          <input id="memoryDreamsEnabled" type="checkbox" checked={form.memoryDreamsEnabled === true} onChange={(e) => setForm((f) => ({ ...f, memoryDreamsEnabled: e.target.checked }))} disabled={!isMemoryEnabled}/>{t("settings.memory.processDreamsFromDailyMemory", " Process dreams from daily memory ")}</label>
        <small>{t("settings.memory.turnsDailyNotesIntoDREAMSMdAndPromotes", "Turns daily notes into DREAMS.md and promotes reusable lessons into MEMORY.md.")}</small>
      </div>

      {isMemoryEnabled && form.memoryDreamsEnabled === true && (<>
          <div className="form-group">
            <label htmlFor="memoryDreamsSchedule">{t("settings.memory.dreamSchedule", "Dream Schedule")}</label>
            <input id="memoryDreamsSchedule" type="text" value={form.memoryDreamsSchedule ?? "0 4 * * *"} onChange={(e) => setForm((f) => ({ ...f, memoryDreamsSchedule: e.target.value }))}/>
            <small>{t("settings.memory.cronExpressionForDreamProcessing", "Cron expression for dream processing.")}</small>
          </div>
          <div className="form-group">
            <button type="button" className="btn btn-sm" onClick={onDreamNow} disabled={dreamRunning || form.memoryDreamsEnabled !== true}>
              {dreamRunning ? (<>
                  <Loader2 size={14} className="animate-spin"/>{t("settings.memory.dreaming", " Dreaming\u2026 ")}</>) : (t("settings.memory.dreamNow", "Dream Now"))}
            </button>
            <small>{t("settings.memory.manuallyTriggerDreamProcessingNow", "Manually trigger dream processing now.")}</small>
          </div>
        </>)}

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

      {memoryLoading ? (<div className="settings-empty-state">{t("settings.memory.loadingMemory", "Loading memory\u2026")}</div>) : (<div className="memory-editor-section">
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
