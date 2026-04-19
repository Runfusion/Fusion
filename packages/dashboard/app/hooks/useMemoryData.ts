import { useState, useEffect, useCallback } from "react";
import {
  fetchMemory,
  saveMemory,
  fetchMemoryInsights,
  saveMemoryInsights,
  triggerInsightExtraction,
  fetchMemoryAudit,
  fetchMemoryStats,
  compactMemory as compactMemoryApi,
  fetchSettings,
  updateSettings,
  fetchMemoryFiles,
  fetchMemoryFile,
  saveMemoryFile,
  installQmd,
  testMemoryRetrieval,
  type MemoryAuditReport,
  type MemoryBackendStatus,
  type MemoryFileInfo,
  type MemoryRetrievalTestResult,
  type QmdInstallResult,
} from "../api";
import { useMemoryBackendStatus } from "./useMemoryBackendStatus";

const DEFAULT_LONG_TERM_MEMORY_PATH = ".fusion/memory/MEMORY.md";
const DEFAULT_AUTO_SUMMARIZE_THRESHOLD = 50_000;
const DEFAULT_AUTO_SUMMARIZE_SCHEDULE = "0 3 * * *";
const DEFAULT_DREAMS_SCHEDULE = "0 4 * * *";

interface UseMemoryDataOptions {
  /** Project ID for multi-project contexts */
  projectId?: string;
}

interface MemorySettingsState {
  memoryEnabled: boolean;
  memoryAutoSummarizeEnabled: boolean;
  memoryAutoSummarizeThresholdChars: number;
  memoryAutoSummarizeSchedule: string;
  memoryDreamsEnabled: boolean;
  memoryDreamsSchedule: string;
}

interface UseMemoryDataResult {
  // Working memory
  workingMemory: string;
  workingMemoryLoading: boolean;
  workingMemoryDirty: boolean;
  setWorkingMemory: (content: string) => void;
  saveWorkingMemory: () => Promise<void>;
  savingWorkingMemory: boolean;

  // Insights
  insightsContent: string | null;
  insightsLoading: boolean;
  insightsExists: boolean;
  refreshInsights: () => Promise<void>;
  saveInsights: (content: string) => Promise<void>;

  // Settings
  memorySettings: MemorySettingsState;
  settingsLoading: boolean;
  savingMemorySettings: boolean;
  saveMemorySettings: (patch: Partial<MemorySettingsState>) => Promise<void>;

  // Multi-file memory editor
  memoryFiles: MemoryFileInfo[];
  memoryFilesLoading: boolean;
  selectedFilePath: string;
  selectedFileContent: string;
  selectedFileLoading: boolean;
  selectedFileDirty: boolean;
  setSelectedFileContent: (content: string) => void;
  selectFile: (path: string) => Promise<void>;
  saveSelectedFile: () => Promise<void>;
  savingSelectedFile: boolean;
  reloadMemoryFiles: () => Promise<void>;

  // Backend status
  backendStatus: MemoryBackendStatus | null;
  backendLoading: boolean;

  // Extraction
  extractInsights: () => Promise<{ success: boolean; summary: string }>;
  extracting: boolean;

  // Audit
  auditReport: MemoryAuditReport | null;
  auditLoading: boolean;
  refreshAudit: () => Promise<void>;

  // Compact
  compactMemory: (path?: string) => Promise<void>;
  compacting: boolean;

  // QMD integration
  installQmdAction: () => Promise<QmdInstallResult>;
  installingQmd: boolean;
  testRetrieval: (query: string) => Promise<MemoryRetrievalTestResult>;

  // Stats
  stats: { workingMemorySize: number; insightsSize: number; insightsExists: boolean } | null;
}

function extractMemorySettings(source: {
  memoryEnabled?: boolean;
  memoryAutoSummarizeEnabled?: boolean;
  memoryAutoSummarizeThresholdChars?: number;
  memoryAutoSummarizeSchedule?: string;
  memoryDreamsEnabled?: boolean;
  memoryDreamsSchedule?: string;
}): MemorySettingsState {
  return {
    memoryEnabled: source.memoryEnabled !== false,
    memoryAutoSummarizeEnabled: source.memoryAutoSummarizeEnabled ?? false,
    memoryAutoSummarizeThresholdChars: source.memoryAutoSummarizeThresholdChars ?? DEFAULT_AUTO_SUMMARIZE_THRESHOLD,
    memoryAutoSummarizeSchedule: source.memoryAutoSummarizeSchedule ?? DEFAULT_AUTO_SUMMARIZE_SCHEDULE,
    memoryDreamsEnabled: source.memoryDreamsEnabled ?? false,
    memoryDreamsSchedule: source.memoryDreamsSchedule ?? DEFAULT_DREAMS_SCHEDULE,
  };
}

function pickDefaultMemoryPath(files: MemoryFileInfo[], currentPath: string): string {
  if (files.some((file) => file.path === currentPath)) {
    return currentPath;
  }

  return files.find((file) => file.path === DEFAULT_LONG_TERM_MEMORY_PATH)?.path
    ?? files[0]?.path
    ?? DEFAULT_LONG_TERM_MEMORY_PATH;
}

export function useMemoryData(options: UseMemoryDataOptions = {}): UseMemoryDataResult {
  const { projectId } = options;

  // Working memory state
  const [workingMemory, setWorkingMemoryRaw] = useState("");
  const [workingMemoryLoading, setWorkingMemoryLoading] = useState(true);
  const [workingMemoryDirty, setWorkingMemoryDirty] = useState(false);
  const [savingWorkingMemory, setSavingWorkingMemory] = useState(false);

  // Insights state
  const [insightsContent, setInsightsContent] = useState<string | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(true);
  const [insightsExists, setInsightsExists] = useState(false);

  // Settings state
  const [memorySettings, setMemorySettings] = useState<MemorySettingsState>(() => extractMemorySettings({}));
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [savingMemorySettings, setSavingMemorySettings] = useState(false);

  // Multi-file state
  const [memoryFiles, setMemoryFiles] = useState<MemoryFileInfo[]>([]);
  const [memoryFilesLoading, setMemoryFilesLoading] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState(DEFAULT_LONG_TERM_MEMORY_PATH);
  const [selectedFileContent, setSelectedFileContentRaw] = useState("");
  const [selectedFileLoading, setSelectedFileLoading] = useState(false);
  const [selectedFileDirty, setSelectedFileDirty] = useState(false);
  const [savingSelectedFile, setSavingSelectedFile] = useState(false);

  // Extraction state
  const [extracting, setExtracting] = useState(false);

  // Audit state
  const [auditReport, setAuditReport] = useState<MemoryAuditReport | null>(null);
  const [auditLoading, setAuditLoading] = useState(true);

  // Compact state
  const [compacting, setCompacting] = useState(false);

  // QMD state
  const [installingQmd, setInstallingQmd] = useState(false);

  // Stats state
  const [stats, setStats] = useState<{ workingMemorySize: number; insightsSize: number; insightsExists: boolean } | null>(null);

  // Backend status from existing hook
  const {
    status: backendStatus,
    loading: backendLoading,
    refresh: refreshBackendStatus,
  } = useMemoryBackendStatus({ projectId });

  const setSelectedFileContent = useCallback((content: string) => {
    setSelectedFileContentRaw(content);
    setSelectedFileDirty(true);
  }, []);

  const loadMemoryFileContent = useCallback(async (path: string) => {
    setSelectedFileLoading(true);
    try {
      const { content } = await fetchMemoryFile(path, projectId);
      setSelectedFilePath(path);
      setSelectedFileContentRaw(content);
      setSelectedFileDirty(false);
    } finally {
      setSelectedFileLoading(false);
    }
  }, [projectId]);

  const reloadMemoryFiles = useCallback(async () => {
    setMemoryFilesLoading(true);
    try {
      const { files } = await fetchMemoryFiles(projectId);
      setMemoryFiles(files);

      if (files.length === 0) {
        setSelectedFilePath(DEFAULT_LONG_TERM_MEMORY_PATH);
        setSelectedFileContentRaw("");
        setSelectedFileDirty(false);
        return;
      }

      const nextPath = pickDefaultMemoryPath(files, selectedFilePath);
      if (nextPath !== selectedFilePath) {
        await loadMemoryFileContent(nextPath);
      }
    } finally {
      setMemoryFilesLoading(false);
    }
  }, [projectId, selectedFilePath, loadMemoryFileContent]);

  // Fetch working memory on mount
  useEffect(() => {
    let cancelled = false;

    async function loadWorkingMemory() {
      try {
        const data = await fetchMemory(projectId);
        if (!cancelled) {
          setWorkingMemoryRaw(data.content);
          setWorkingMemoryLoading(false);
        }
      } catch {
        if (!cancelled) {
          setWorkingMemoryRaw("");
          setWorkingMemoryLoading(false);
        }
      }
    }

    loadWorkingMemory();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch insights on mount
  useEffect(() => {
    let cancelled = false;

    async function loadInsights() {
      try {
        const data = await fetchMemoryInsights(projectId);
        if (!cancelled) {
          setInsightsContent(data.content);
          setInsightsExists(data.exists);
          setInsightsLoading(false);
        }
      } catch {
        if (!cancelled) {
          setInsightsContent(null);
          setInsightsExists(false);
          setInsightsLoading(false);
        }
      }
    }

    loadInsights();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch memory settings on mount
  useEffect(() => {
    let cancelled = false;

    async function loadSettings() {
      setSettingsLoading(true);
      try {
        const settings = await fetchSettings(projectId);
        if (!cancelled) {
          setMemorySettings(extractMemorySettings(settings));
        }
      } catch {
        if (!cancelled) {
          setMemorySettings(extractMemorySettings({}));
        }
      } finally {
        if (!cancelled) {
          setSettingsLoading(false);
        }
      }
    }

    loadSettings();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch memory files and initial selected file content
  useEffect(() => {
    let cancelled = false;

    async function loadFiles() {
      setMemoryFilesLoading(true);
      try {
        const { files } = await fetchMemoryFiles(projectId);
        if (cancelled) {
          return;
        }

        setMemoryFiles(files);

        if (files.length === 0) {
          setSelectedFilePath(DEFAULT_LONG_TERM_MEMORY_PATH);
          setSelectedFileContentRaw("");
          setSelectedFileDirty(false);
          return;
        }

        const nextPath = pickDefaultMemoryPath(files, selectedFilePath);
        const { content } = await fetchMemoryFile(nextPath, projectId);
        if (cancelled) {
          return;
        }

        setSelectedFilePath(nextPath);
        setSelectedFileContentRaw(content);
        setSelectedFileDirty(false);
      } catch {
        if (!cancelled) {
          setMemoryFiles([]);
          setSelectedFilePath(DEFAULT_LONG_TERM_MEMORY_PATH);
          setSelectedFileContentRaw("");
          setSelectedFileDirty(false);
        }
      } finally {
        if (!cancelled) {
          setMemoryFilesLoading(false);
        }
      }
    }

    loadFiles();

    return () => {
      cancelled = true;
    };
  }, [projectId, selectedFilePath]);

  // Fetch audit on mount
  useEffect(() => {
    let cancelled = false;

    async function loadAudit() {
      try {
        const data = await fetchMemoryAudit(projectId);
        if (!cancelled) {
          setAuditReport(data);
          setAuditLoading(false);
        }
      } catch {
        if (!cancelled) {
          setAuditReport(null);
          setAuditLoading(false);
        }
      }
    }

    loadAudit();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Fetch lightweight stats on mount
  useEffect(() => {
    let cancelled = false;

    async function loadStats() {
      try {
        const data = await fetchMemoryStats(projectId);
        if (!cancelled) {
          setStats(data);
        }
      } catch {
        if (!cancelled) {
          setStats(null);
        }
      }
    }

    loadStats();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Set working memory with dirty tracking
  const setWorkingMemory = useCallback((content: string) => {
    setWorkingMemoryRaw(content);
    setWorkingMemoryDirty(true);
  }, []);

  // Save working memory
  const saveWorkingMemory = useCallback(async () => {
    if (!workingMemoryDirty) return;

    setSavingWorkingMemory(true);
    try {
      await saveMemory(workingMemory, projectId);
      setWorkingMemoryDirty(false);
    } finally {
      setSavingWorkingMemory(false);
    }
  }, [workingMemory, workingMemoryDirty, projectId]);

  // Save memory settings
  const saveMemorySettings = useCallback(async (patch: Partial<MemorySettingsState>) => {
    setSavingMemorySettings(true);
    try {
      const updated = await updateSettings(patch, projectId);
      setMemorySettings(extractMemorySettings(updated));
    } finally {
      setSavingMemorySettings(false);
    }
  }, [projectId]);

  // Select a memory file and load its content
  const selectFile = useCallback(async (path: string) => {
    await loadMemoryFileContent(path);
  }, [loadMemoryFileContent]);

  // Save selected file content
  const saveSelectedFile = useCallback(async () => {
    if (!selectedFileDirty) {
      return;
    }

    setSavingSelectedFile(true);
    try {
      await saveMemoryFile(selectedFilePath, selectedFileContent, projectId);
      setSelectedFileDirty(false);
      await reloadMemoryFiles();
    } finally {
      setSavingSelectedFile(false);
    }
  }, [selectedFileContent, selectedFileDirty, selectedFilePath, projectId, reloadMemoryFiles]);

  // Install qmd and refresh backend status
  const installQmdAction = useCallback(async () => {
    setInstallingQmd(true);
    try {
      const result = await installQmd(projectId);
      await refreshBackendStatus();
      return result;
    } finally {
      setInstallingQmd(false);
    }
  }, [projectId, refreshBackendStatus]);

  // Test retrieval
  const testRetrievalAction = useCallback(async (query: string) => {
    return testMemoryRetrieval(query, projectId);
  }, [projectId]);

  // Refresh audit
  const refreshAudit = useCallback(async () => {
    try {
      const data = await fetchMemoryAudit(projectId);
      setAuditReport(data);
    } catch {
      setAuditReport(null);
    }
  }, [projectId]);

  // Refresh insights
  const refreshInsights = useCallback(async () => {
    try {
      const data = await fetchMemoryInsights(projectId);
      setInsightsContent(data.content);
      setInsightsExists(data.exists);
    } catch {
      setInsightsContent(null);
      setInsightsExists(false);
    }
  }, [projectId]);

  // Save insights
  const saveInsights = useCallback(async (content: string) => {
    await saveMemoryInsights(content, projectId);
    await refreshInsights();
  }, [projectId, refreshInsights]);

  // Extract insights
  const extractInsights = useCallback(async (): Promise<{ success: boolean; summary: string }> => {
    setExtracting(true);
    try {
      const result = await triggerInsightExtraction(projectId);
      // Refresh insights and audit after extraction
      await Promise.all([refreshInsights(), refreshAudit()]);
      return { success: result.success, summary: result.summary };
    } finally {
      setExtracting(false);
    }
  }, [projectId, refreshInsights, refreshAudit]);

  // Compact memory
  const compactMemoryAction = useCallback(async (path?: string) => {
    setCompacting(true);
    try {
      const result = path
        ? await compactMemoryApi(path, projectId)
        : await compactMemoryApi(projectId);

      if (path) {
        const nextPath = result.path ?? path;
        setSelectedFilePath(nextPath);
        setSelectedFileContentRaw(result.content);
        setSelectedFileDirty(false);
        await reloadMemoryFiles();
        return;
      }

      // Legacy behavior for single-file working memory editor
      setWorkingMemoryRaw(result.content);
      setWorkingMemoryDirty(true);
    } finally {
      setCompacting(false);
    }
  }, [projectId, reloadMemoryFiles]);

  return {
    // Working memory
    workingMemory,
    workingMemoryLoading,
    workingMemoryDirty,
    setWorkingMemory,
    saveWorkingMemory,
    savingWorkingMemory,

    // Insights
    insightsContent,
    insightsLoading,
    insightsExists,
    refreshInsights,
    saveInsights,

    // Settings
    memorySettings,
    settingsLoading,
    savingMemorySettings,
    saveMemorySettings,

    // Multi-file memory editor
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

    // Backend status
    backendStatus,
    backendLoading,

    // Extraction
    extractInsights,
    extracting,

    // Audit
    auditReport,
    auditLoading,
    refreshAudit,

    // Compact
    compactMemory: compactMemoryAction,
    compacting,

    // QMD integration
    installQmdAction,
    installingQmd,
    testRetrieval: testRetrievalAction,

    // Stats
    stats,
  };
}
