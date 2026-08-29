import "./AgentImportModal.css";
import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Upload, FileText, CheckCircle, AlertTriangle, X, Loader2, FolderOpen, Globe, Search, RefreshCw } from "lucide-react";
import { fetchCompanies, type CompanyEntry } from "../api";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";

import { FloatingWindow } from "./FloatingWindow";

export interface AgentImportModalProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: () => void;
  projectId?: string;
  initialInputMethod?: InputMethod;
}

/** Parsed agent preview item for display before import */
interface AgentPreview {
  name: string;
  role: string;
  title?: string;
  icon?: string;
  reportsTo?: string;
  instructionsText?: string;
  skills?: string[];
}

interface SkillPreview {
  name: string;
  description?: string;
}

/** Skill import result from the API */
interface SkillImportResult {
  imported: Array<{ name: string; path: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
}

/** Import result from the API */
interface ImportResult {
  companyName?: string;
  companySlug?: string;
  created: Array<{ id: string; name: string }>;
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  skills?: SkillImportResult;
  warnings?: string[];
}

interface DirectoryAgentInput {
  name: string;
  title?: string;
  icon?: string;
  role?: string;
  reportsTo?: string;
  skills?: string[];
  instructionBody?: string;
}

/** API error response shape */
interface ApiErrorResponse {
  error: string;
}

type ModalStep = "input" | "preview" | "result";
type InputMethod = "paste" | "file" | "directory" | "browse";

function parseDirectoryAgentManifest(content: string): DirectoryAgentInput {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
  if (!match) {
    throw new Error("Missing YAML frontmatter delimiters (---)");
  }

  const frontmatterLines = match[1].split(/\r?\n/);
  const body = match[2] ?? "";
  const result: DirectoryAgentInput = { name: "" };
  const skills: string[] = [];
  let inSkills = false;

  for (const rawLine of frontmatterLines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("skills:")) {
      inSkills = true;
      continue;
    }

    if (inSkills && trimmed.startsWith("- ")) {
      skills.push(trimmed.slice(2).trim());
      continue;
    }

    inSkills = false;

    const [key, ...valueParts] = trimmed.split(":");
    const value = valueParts.join(":").trim();
    const normalizedValue = value.replace(/^['"]|['"]$/g, "");

    if (key === "name") result.name = normalizedValue;
    if (key === "title") result.title = normalizedValue;
    if (key === "icon") result.icon = normalizedValue;
    if (key === "role") result.role = normalizedValue;
    if (key === "reportsTo") result.reportsTo = normalizedValue;
  }

  if (!result.name) {
    throw new Error("Missing required field: name");
  }

  if (skills.length > 0) {
    result.skills = skills;
  }
  if (body.trim().length > 0) {
    result.instructionBody = body;
  }

  return result;
}

/**
 * Modal for importing agents from Agent Companies manifests.
 *
 * Supports three input methods:
 * - File upload (.md/.txt files)
 * - Directory upload (webkitdirectory)
 * - Paste raw manifest content
 *
 * Flow: Input → Preview parsed agents → Import → Show results
 */
export function AgentImportModal({ isOpen, onClose, onImported, projectId, initialInputMethod = "paste" }: AgentImportModalProps) {
  const { t } = useTranslation("app");
  useMobileScrollLock(isOpen);
  const [step, setStep] = useState<ModalStep>("input");
  const [inputMethod, setInputMethod] = useState<InputMethod>(initialInputMethod);
  const [manifestContent, setManifestContent] = useState("");
  const [directoryAgents, setDirectoryAgents] = useState<DirectoryAgentInput[]>([]);
  const [companyName, setCompanyName] = useState("Unknown");
  const [agents, setAgents] = useState<AgentPreview[]>([]);
  const [skills, setSkills] = useState<SkillPreview[]>([]);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [selectedAgentNames, setSelectedAgentNames] = useState<string[]>([]);
  const [selectedSkillNames, setSelectedSkillNames] = useState<string[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directoryInputRef = useRef<HTMLInputElement>(null);

  // Browse mode state
  const [companies, setCompanies] = useState<CompanyEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCompany, setSelectedCompany] = useState<CompanyEntry | null>(null);
  const [isLoadingCompanies, setIsLoadingCompanies] = useState(false);
  const [companiesError, setCompaniesError] = useState<string | null>(null);

  // Track whether we've attempted to fetch to prevent infinite retry loops
  const fetchAttemptedRef = useRef(false);

  // Load companies when browse mode is selected
  useEffect(() => {
    if (inputMethod === "browse" && !fetchAttemptedRef.current && !isLoadingCompanies) {
      fetchAttemptedRef.current = true;
      setIsLoadingCompanies(true);
      setCompaniesError(null);
      fetchCompanies()
        .then((data) => {
          if (data.error) {
            setCompaniesError(data.error);
          } else if (data.companies.length > 0) {
            setCompanies(data.companies);
          } else {
            setCompaniesError(t("agents.noCompaniesAvailable", "No companies available"));
          }
        })
        .catch((err) => {
          setCompaniesError(err instanceof Error ? err.message : t("agents.failedToLoadCompanies", "Failed to load companies"));
        })
        .finally(() => {
          setIsLoadingCompanies(false);
        });
    }
  }, [inputMethod, isLoadingCompanies, t]);

  /** Retry fetching companies after an error - calls fetch directly to bypass useEffect */
  const handleRetryFetchCompanies = useCallback(() => {
    fetchAttemptedRef.current = true; // Prevent useEffect from also firing
    setCompaniesError(null);
    setCompanies([]);
    setSelectedCompany(null);
    setIsLoadingCompanies(true);
    fetchCompanies()
      .then((data) => {
        if (data.error) {
          setCompaniesError(data.error);
        } else if (data.companies.length > 0) {
          setCompanies(data.companies);
        } else {
          setCompaniesError(t("agents.noCompaniesAvailable", "No companies available"));
        }
      })
      .catch((err) => {
        setCompaniesError(err instanceof Error ? err.message : t("agents.failedToLoadCompanies", "Failed to load companies"));
      })
      .finally(() => {
        setIsLoadingCompanies(false);
      });
  }, [t]);

  const reset = useCallback(() => {
    setStep("input");
    setInputMethod(initialInputMethod);
    setManifestContent("");
    setDirectoryAgents([]);
    setCompanyName("Unknown");
    setAgents([]);
    setSkills([]);
    setPreviewWarnings([]);
    setSelectedAgentNames([]);
    setSelectedSkillNames([]);
    setIsParsing(false);
    setIsImporting(false);
    setParseError(null);
    setImportResult(null);
    setImportError(null);
    setCompanies([]);
    setSearchQuery("");
    setSelectedCompany(null);
    setIsLoadingCompanies(false);
    setCompaniesError(null);
    fetchAttemptedRef.current = false;
  }, [initialInputMethod]);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      setInputMethod("file");
      setDirectoryAgents([]);
      setManifestContent(content);
      setParseError(null);
    };
    reader.onerror = () => {
      setParseError(t("agents.failedToReadFile", "Failed to read file"));
    };
    reader.readAsText(file);

    // Reset file input so the same file can be re-selected
    e.target.value = "";
  }, [t]);

  const handleDirectoryChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    try {
      const agentFiles = files
        .filter((file) => (file.webkitRelativePath || file.name).toLowerCase().endsWith("agents.md"))
        .sort((a, b) => {
          const aPath = a.webkitRelativePath || a.name;
          const bPath = b.webkitRelativePath || b.name;
          return aPath.localeCompare(bPath);
        });

      if (agentFiles.length === 0) {
        setParseError(t("agents.noAgentsMdFiles", "Selected directory has no AGENTS.md files"));
        return;
      }

      const parsedAgents: DirectoryAgentInput[] = [];
      for (const file of agentFiles) {
        const content = await file.text();
        parsedAgents.push(parseDirectoryAgentManifest(content));
      }

      setInputMethod("directory");
      setDirectoryAgents(parsedAgents);
      setManifestContent("");
      setParseError(null);
    } catch {
      setParseError(t("agents.failedToParseDirectory", "Failed to parse AGENTS.md files from selected directory"));
    } finally {
      e.target.value = "";
    }
  }, [t]);

  /** Build the API URL with optional projectId */
  function buildUrl(path: string): string {
    if (!projectId) return `/api${path}`;
    const separator = path.includes("?") ? "&" : "?";
    return `/api${path}${separator}projectId=${encodeURIComponent(projectId)}`;
  }

  /** Parse the manifest content by calling the API with dryRun=true */
  const handleParse = useCallback(async () => {
    if (inputMethod === "directory" && directoryAgents.length === 0) {
      setParseError(t("agents.selectDirectory", "Please select a directory containing AGENTS.md files"));
      return;
    }
    if (inputMethod === "browse" && !selectedCompany) {
      setParseError(t("agents.selectCompany", "Please select a company from the catalog"));
      return;
    }
    if (inputMethod !== "directory" && inputMethod !== "browse" && !manifestContent.trim()) {
      setParseError(t("agents.provideManifest", "Please provide manifest content"));
      return;
    }

    setIsParsing(true);
    setParseError(null);

    try {
      let body: Record<string, unknown>;

      if (inputMethod === "directory") {
        body = { agents: directoryAgents, dryRun: true };
      } else if (inputMethod === "browse" && selectedCompany) {
        body = { importSource: "companies.sh", companySlug: selectedCompany.slug, dryRun: true };
      } else {
        body = { manifest: manifestContent, dryRun: true };
      }

      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as ApiErrorResponse;
        throw new Error(data.error ?? `Parse failed (${res.status})`);
      }

      const data = await res.json() as {
        companyName?: string;
        agents?: AgentPreview[];
        skills?: SkillPreview[];
        created: string[];
        skipped: string[];
        errors: Array<{ name: string; error: string }>;
        warnings?: string[];
      };

      const previewAgents = (data.agents && data.agents.length > 0)
        ? data.agents
        : data.created.map((name) => ({ name, role: "custom" }));
      const previewSkills = Array.isArray(data.skills) ? data.skills : [];

      setCompanyName(data.companyName ?? "Unknown");
      setAgents(previewAgents);
      setSkills(previewSkills);
      setPreviewWarnings(Array.isArray(data.warnings) ? data.warnings : []);
      setSelectedAgentNames(previewAgents.map((agent) => agent.name));
      setSelectedSkillNames(previewSkills.map((skill) => skill.name));
      setStep("preview");
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t("agents.failedToParseManifest", "Failed to parse manifest"));
    } finally {
      setIsParsing(false);
    }
  }, [inputMethod, directoryAgents, manifestContent, selectedCompany, projectId, t]);

  /** Execute the actual import */
  const handleImport = useCallback(async () => {
    setIsImporting(true);
    setImportError(null);

    try {
      let body: Record<string, unknown>;

      if (inputMethod === "directory") {
        body = {
          agents: directoryAgents,
          skipExisting: true,
          selectedAgents: selectedAgentNames,
          selectedSkills: selectedSkillNames,
        };
      } else if (inputMethod === "browse" && selectedCompany) {
        body = {
          importSource: "companies.sh",
          companySlug: selectedCompany.slug,
          skipExisting: true,
          selectedAgents: selectedAgentNames,
          selectedSkills: selectedSkillNames,
        };
      } else {
        body = {
          manifest: manifestContent,
          skipExisting: true,
          selectedAgents: selectedAgentNames,
          selectedSkills: selectedSkillNames,
        };
      }

      const res = await fetch(buildUrl("/agents/import"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as ApiErrorResponse;
        throw new Error(data.error ?? `Import failed (${res.status})`);
      }

      const data = await res.json() as ImportResult;
      setImportResult(data);
      setStep("result");
      onImported();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : t("agents.failedToImport", "Failed to import agents"));
    } finally {
      setIsImporting(false);
    }
  }, [
    inputMethod,
    directoryAgents,
    manifestContent,
    selectedCompany,
    selectedAgentNames,
    selectedSkillNames,
    projectId,
    onImported,
    t,
  ]);

  const selectedAgentCount = selectedAgentNames.length;
  const selectedSkillCount = selectedSkillNames.length;
  const selectedAgentLabel = t("agents.selectedAgentLabel", "{{count}} Agent{{plural}}", { count: selectedAgentCount, plural: selectedAgentCount !== 1 ? "s" : "" });
  const selectedSkillLabel = t("agents.selectedSkillLabel", "{{count}} Skill{{plural}}", { count: selectedSkillCount, plural: selectedSkillCount !== 1 ? "s" : "" });
  const importActionLabel = selectedAgentCount > 0 && selectedSkillCount > 0
    ? `${selectedAgentLabel} + ${selectedSkillLabel}`
    : selectedSkillCount > 0
      ? selectedSkillLabel
      : selectedAgentLabel;
  const importLoadingLabel = selectedAgentCount > 0 && selectedSkillCount > 0
    ? t("agents.importingAgentsAndSkills", "Importing {{agentCount}} agent{{agentPlural}} and {{skillCount}} skill{{skillPlural}}...", { agentCount: selectedAgentCount, agentPlural: selectedAgentCount !== 1 ? "s" : "", skillCount: selectedSkillCount, skillPlural: selectedSkillCount !== 1 ? "s" : "" })
    : selectedSkillCount > 0
      ? t("agents.importingSkills", "Importing {{count}} skill{{plural}}...", { count: selectedSkillCount, plural: selectedSkillCount !== 1 ? "s" : "" })
      : t("agents.importingAgents", "Importing {{count}} agent{{plural}}...", { count: selectedAgentCount, plural: selectedAgentCount !== 1 ? "s" : "" });

  const toggleAgentSelection = (name: string) => {
    setSelectedAgentNames((current) => (
      current.includes(name)
        ? current.filter((selectedName) => selectedName !== name)
        : [...current, name]
    ));
  };

  const toggleSkillSelection = (name: string) => {
    setSelectedSkillNames((current) => (
      current.includes(name)
        ? current.filter((selectedName) => selectedName !== name)
        : [...current, name]
    ));
  };

  if (!isOpen) return null;

  return (
        <FloatingWindow windowKey="agent-import" modal title={t("agents.importAgents", "Import Agents")} ariaLabel={t("agents.importAgents", "Import agents")} onClose={handleClose} hideHeader dragHandleSelector=".agent-import-dialog .agent-dialog-header" className="floating-window--agent-import" defaultSize={{ width: 720, height: 640 }} minSize={{ width: 420, height: 320 }} persistGeometryKey="floating-window:agent-import" suspendGeometryPersistenceOnMobile suspendGeometryPersistenceOnShortViewport closeOnOutsidePointerDown>
      {/* FNXC:ModalTouchGeometry 2026-07-26-16:07: Import mapping is reflowable, so FloatingWindow owns tablet touch geometry and retains prior outside dismissal. */}
      <div className="agent-dialog agent-import-dialog">
        {/* Header */}
        <div className="agent-dialog-header">
          <span className="agent-dialog-header-title">{t("agents.importAgents", "Import Agents")}</span>
          <button className="modal-close" onClick={handleClose} aria-label={t("agents.close", "Close")}>
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="agent-dialog-body">
          {/* Step 1: Input */}
          {step === "input" && (
            <div className="agent-import-input">
              <p className="agent-import-description">
                {t("agents.importDescription", "Import agents from an Agent Companies package. Browse the companies.sh catalog to discover published agents, upload an AGENTS.md file, select a directory, or paste manifest content.")}
              </p>

              {/* File upload */}
              <div className="agent-import-file-upload">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.txt"
                  onChange={handleFileChange}
                  className="agent-import-file-input"
                  aria-label="Upload agent manifest file"
                />
                <input
                  ref={directoryInputRef}
                  type="file"
                  // @ts-expect-error webkitdirectory is non-standard but supported by Chromium browsers
                  webkitdirectory=""
                  multiple
                  onChange={handleDirectoryChange}
                  className="agent-import-file-input"
                  aria-label="Select directory"
                />
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={16} />
                  {t("agents.chooseFile", "Choose File")}
                </button>
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => directoryInputRef.current?.click()}
                >
                  <FolderOpen size={16} />
                  {t("agents.selectDirectory", "Select Directory")}
                </button>
                <button
                  type="button"
                  className="btn agent-import-upload-btn"
                  onClick={() => {
                    setInputMethod("browse");
                    setDirectoryAgents([]);
                    setManifestContent("");
                    setSelectedCompany(null);
                    setParseError(null);
                  }}
                >
                  <Globe size={16} />
                  {t("agents.browseCatalog", "Browse Catalog")}
                </button>
                <span className="agent-import-file-hint">{t("agents.fileHint", ".md and .txt files supported")}</span>
              </div>

              {/* Browse Catalog Mode */}
              {inputMethod === "browse" && (
                <div className="agent-import-browse">
                  <div className="agent-import-browse-header">
                    <div className="agent-import-browse-search">
                      <Search size={16} className="agent-import-browse-search-icon" />
                      <input
                        type="text"
                        className="agent-import-browse-search-input"
                        placeholder={t("agents.searchCompanies", "Search companies...")}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        aria-label={t("agents.searchCompanies", "Search companies")}
                      />
                    </div>
                    {selectedCompany && (
                      <div className="agent-import-browse-selected">
                        <span className="agent-import-browse-selected-label">{t("agents.selected", "Selected:")} </span>
                        <span className="agent-import-browse-selected-name">{selectedCompany.name}</span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setSelectedCompany(null)}
                        >
                          {t("agents.change", "Change")}
                        </button>
                      </div>
                    )}
                  </div>

                  {isLoadingCompanies && (
                    <div className="agent-import-browse-loading">
                      <Loader2 size={20} className="spin" />
                      <span>{t("agents.loadingCompanies", "Loading companies...")}</span>
                    </div>
                  )}

                  {companiesError && (
                    <div className="agent-import-browse-error">
                      <AlertTriangle size={16} />
                      <span>{companiesError}</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={handleRetryFetchCompanies}
                      >
                        <RefreshCw size={14} />
                        {t("agents.retry", "Retry")}
                      </button>
                    </div>
                  )}

                  {!isLoadingCompanies && !companiesError && (
                    <div className="agent-import-browse-list">
                      {companies
                        .filter((company) =>
                          searchQuery === "" ||
                          company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (company.tagline?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
                        )
                        .map((company) => (
                          <div
                            key={company.slug}
                            className={`agent-import-browse-item ${selectedCompany?.slug === company.slug ? "agent-import-browse-item--selected" : ""}`}
                            onClick={() => setSelectedCompany(company)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                setSelectedCompany(company);
                              }
                            }}
                          >
                            <div className="agent-import-browse-item-header">
                              <span className="agent-import-browse-item-name">{company.name}</span>
                              {company.installs !== undefined && (
                                <span className="agent-import-browse-item-installs">{company.installs.toLocaleString()} {t("agents.installs", "installs")}</span>
                              )}
                            </div>
                            {company.tagline && (
                              <span className="agent-import-browse-item-tagline">{company.tagline}</span>
                            )}
                            {company.repo && (
                              <span className="agent-import-browse-item-repo">{company.repo}</span>
                            )}
                          </div>
                        ))}
                      {companies.filter((company) =>
                        searchQuery === "" ||
                        company.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        (company.tagline?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
                      ).length === 0 && (
                        <p className="agent-import-browse-empty">
                          {searchQuery ? t("agents.noCompaniesMatch", "No companies match your search") : t("agents.noCompaniesAvailable", "No companies available")}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Or divider - only show when not in browse mode */}
              {inputMethod !== "browse" && (
                <>
                  <div className="agent-import-divider">
                    <span>{t("agents.orPasteManifest", "or paste manifest content")}</span>
                  </div>

                  {/* Text area for paste */}
                  <textarea
                    className="agent-import-textarea"
                    placeholder={t("agents.manifestPlaceholder", "---\nname: CEO\ntitle: Chief Executive Officer\nreportsTo: null\nskills:\n  - review\n---\nAgent instructions go here...")}
                    value={manifestContent}
                    onChange={(e) => {
                      setInputMethod("paste");
                      setDirectoryAgents([]);
                      setManifestContent(e.target.value);
                      setParseError(null);
                    }}
                    rows={8}
                    aria-label={t("agents.manifestContent", "Manifest content")}
                  />
                </>
              )}

              <p className="agent-import-file-hint">{t("agents.currentInput", "Current input: {{method}}", { method: inputMethod })}</p>

              {parseError && (
                <p className="agent-dialog-error">
                  <AlertTriangle size={14} />
                  {parseError}
                </p>
              )}
            </div>
          )}

          {/* Step 2: Preview */}
          {step === "preview" && (
            <div className="agent-import-preview">
              <div className="agent-import-company">
                <span className="agent-import-company-label">{t("agents.company", "Company")}</span>
                <span className="agent-import-company-name">{companyName}</span>
              </div>

              {previewWarnings.length > 0 && (
                <div className="agent-import-result-warnings">
                  {previewWarnings.map((warning, idx) => (
                    <div key={idx} className="agent-import-result-warning">
                      <AlertTriangle size={12} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="agent-import-count">
                <FileText size={14} />
                <span>{t("agents.agentsFound", "{{count}} agent{{plural}} found", { count: agents.length, plural: agents.length !== 1 ? "s" : "" })}</span>
              </div>

              {agents.length > 0 && (
                <div className="agent-import-selection-controls">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedAgentNames(agents.map((agent) => agent.name))}
                  >
                    {t("agents.selectAllAgents", "Select all agents")}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setSelectedAgentNames([])}
                  >
                    {t("agents.clearAgents", "Clear agents")}
                  </button>
                </div>
              )}

              {agents.length > 0 ? (
                <div className="agent-import-agent-list">
                  {agents.map((agent, idx) => (
                    <div key={idx} className="agent-import-agent-item">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          aria-label={t("agents.selectAgent", "Select agent {{name}}", { name: agent.name })}
                          checked={selectedAgentNames.includes(agent.name)}
                          onChange={() => toggleAgentSelection(agent.name)}
                        />
                      </label>
                      <span className="agent-import-agent-icon">{agent.icon || "🤖"}</span>
                      <div className="agent-import-agent-details">
                        <span className="agent-import-agent-name">{agent.name}</span>
                        <span className="agent-import-agent-meta">
                          {agent.title && <span className="agent-import-agent-title">{agent.title} · </span>}
                          <span className="agent-import-agent-role">{agent.role}</span>
                          {agent.reportsTo && (
                            <span className="agent-import-agent-reports">{t("agents.importReportsTo", " · reports to {{agent}}", { agent: agent.reportsTo })}</span>
                          )}
                          {agent.skills && agent.skills.length > 0 && (
                            <span className="agent-import-agent-model">{t("agents.importSkills", " · skills: {{skills}}", { skills: agent.skills.join(", ") })}</span>
                          )}
                        </span>
                        {agent.instructionsText && (
                          <span className="agent-import-agent-instructions">
                            {agent.instructionsText.slice(0, 100)}{agent.instructionsText.length > 100 ? "..." : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="agent-import-empty">{t("agents.noAgentsFound", "No agents found in the manifest.")}</p>
              )}

              {skills.length > 0 && (
                <div className="agent-import-skills-section">
                  <div className="agent-import-count">
                    <FileText size={14} />
                    <span>{t("agents.skillsFound", "{{count}} skill{{plural}} found", { count: skills.length, plural: skills.length !== 1 ? "s" : "" })}</span>
                  </div>
                  <div className="agent-import-selection-controls">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSelectedSkillNames(skills.map((skill) => skill.name))}
                    >
                      {t("agents.selectAllSkills", "Select all skills")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSelectedSkillNames([])}
                    >
                      {t("agents.clearSkills", "Clear skills")}
                    </button>
                  </div>
                  <div className="agent-import-skill-list">
                    {skills.map((skill, idx) => (
                      <div key={`${skill.name}-${idx}`} className="agent-import-skill-item">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            aria-label={t("agents.selectSkill", "Select skill {{name}}", { name: skill.name })}
                            checked={selectedSkillNames.includes(skill.name)}
                            onChange={() => toggleSkillSelection(skill.name)}
                          />
                        </label>
                        <span className="agent-import-skill-icon">⚡</span>
                        <div className="agent-import-skill-details">
                          <span className="agent-import-skill-name">{skill.name}</span>
                          {skill.description && (
                            <span className="agent-import-skill-description">{skill.description}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {importError && (
                <p className="agent-dialog-error">
                  <AlertTriangle size={14} />
                  {importError}
                </p>
              )}
            </div>
          )}

          {/* Step 3: Result */}
          {step === "result" && importResult && (
            <div className="agent-import-result">
              <div className="agent-import-result-icon">
                <CheckCircle size={32} />
              </div>
              <h3 className="agent-import-result-title">{t("agents.importComplete", "Import Complete")}</h3>
              <p className="agent-import-result-company">
                {t("agents.from", "From")} <strong>{importResult.companyName ?? "Unknown"}</strong>
              </p>

              <div className="agent-import-result-stats">
                {importResult.created.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--success">
                    <span>{t("agents.resultCreated", "{{count}} created", { count: importResult.created.length })}</span>
                  </div>
                )}
                {importResult.skipped.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--skipped">
                    <span>{t("agents.resultSkipped", "{{count}} skipped (already exist)", { count: importResult.skipped.length })}</span>
                  </div>
                )}
                {importResult.errors.length > 0 && (
                  <div className="agent-import-result-stat agent-import-result-stat--error">
                    <span>{t("agents.resultErrors", "{{count}} error{{plural}}", { count: importResult.errors.length, plural: importResult.errors.length !== 1 ? "s" : "" })}</span>
                  </div>
                )}
              </div>

              {importResult.created.length > 0 && (
                <div className="agent-import-result-agents">
                  {importResult.created.map((a, idx) => (
                    <div key={idx} className="agent-import-result-agent">
                      <CheckCircle size={12} />
                      <span>{a.name}</span>
                    </div>
                  ))}
                </div>
              )}

              {importResult.errors.length > 0 && (
                <div className="agent-import-result-errors">
                  {importResult.errors.map((err, idx) => (
                    <div key={idx} className="agent-import-result-error">
                      <X size={12} />
                      <span>{err.name}: {err.error}</span>
                    </div>
                  ))}
                </div>
              )}

              {importResult.warnings && importResult.warnings.length > 0 && (
                <div className="agent-import-result-warnings">
                  {importResult.warnings.map((warning, idx) => (
                    <div key={idx} className="agent-import-result-warning">
                      <AlertTriangle size={12} />
                      <span>{warning}</span>
                    </div>
                  ))}
                </div>
              )}

              {importResult.skills && (
                <>
                  <div className="agent-import-result-divider" />
                  <h4 className="agent-import-result-section-title">{t("agents.skills", "Skills")}</h4>
                  <div className="agent-import-result-stats">
                    {importResult.skills.imported.length > 0 && (
                      <div className="agent-import-result-stat agent-import-result-stat--success">
                        <span>{t("agents.skillsImported", "{{count}} skill{{plural}} imported", { count: importResult.skills.imported.length, plural: importResult.skills.imported.length !== 1 ? "s" : "" })}</span>
                      </div>
                    )}
                    {importResult.skills.skipped.length > 0 && (
                      <div className="agent-import-result-stat agent-import-result-stat--skipped">
                        <span>{t("agents.skillsSkipped", "{{count}} skill{{plural}} skipped (already exist)", { count: importResult.skills.skipped.length, plural: importResult.skills.skipped.length !== 1 ? "s" : "" })}</span>
                      </div>
                    )}
                    {importResult.skills.errors.length > 0 && (
                      <div className="agent-import-result-stat agent-import-result-stat--error">
                        <span>{t("agents.skillsErrors", "{{count}} skill{{plural}} error{{pluralError}}", { count: importResult.skills.errors.length, plural: importResult.skills.errors.length !== 1 ? "s" : "", pluralError: importResult.skills.errors.length !== 1 ? "s" : "" })}</span>
                      </div>
                    )}
                    {importResult.skills.imported.length === 0 && importResult.skills.skipped.length === 0 && importResult.skills.errors.length === 0 && (
                      <div className="agent-import-result-stat agent-import-result-stat--skipped">
                        <span>{t("agents.noSkillsInPackage", "No skills in package")}</span>
                      </div>
                    )}
                  </div>

                  {importResult.skills.imported.length > 0 && (
                    <div className="agent-import-result-agents">
                      {importResult.skills.imported.map((skill, idx) => (
                        <div key={idx} className="agent-import-result-agent">
                          <CheckCircle size={12} />
                          <span>{skill.name}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {importResult.skills.errors.length > 0 && (
                    <div className="agent-import-result-errors">
                      {importResult.skills.errors.map((err, idx) => (
                        <div key={idx} className="agent-import-result-error">
                          <X size={12} />
                          <span>{err.name}: {err.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="agent-dialog-footer">
          {step === "preview" && (
            <button className="btn" onClick={() => setStep("input")} disabled={isImporting}>
              {t("agents.back", "Back")}
            </button>
          )}
          <button className="btn" onClick={handleClose} disabled={isImporting}>
            {step === "result" ? t("agents.close", "Close") : t("agents.cancel", "Cancel")}
          </button>
          {step === "input" && (
            <button
              className="btn btn-task-create"
              onClick={() => void handleParse()}
              disabled={
                isParsing || (
                  inputMethod === "directory"
                    ? directoryAgents.length === 0
                    : inputMethod === "browse"
                      ? !selectedCompany
                      : !manifestContent.trim()
                )
              }
            >
              {isParsing ? (
                <>
                  <Loader2 size={14} className="spin" />
                  {t("agents.parsing", "Parsing...")}
                </>
              ) : (
                t("agents.preview", "Preview")
              )}
            </button>
          )}
          {step === "preview" && (
            <button
              className="btn btn-task-create"
              onClick={() => void handleImport()}
              disabled={isImporting || (selectedAgentCount === 0 && selectedSkillCount === 0)}
            >
              {isImporting ? (
                <>
                  <Loader2 size={14} className="spin" />
                  {importLoadingLabel}
                </>
              ) : (
                t("agents.importButton", "Import {{label}}", { label: importActionLabel })
              )}
            </button>
          )}
        </div>
      </div>
    </FloatingWindow>
  );
}
