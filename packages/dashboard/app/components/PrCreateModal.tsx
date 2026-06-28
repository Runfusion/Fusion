import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, RefreshCw, Sparkles, X, XCircle } from "lucide-react";
import { getErrorMessage, type PrInfo, type StructuredGhError } from "@fusion/core";
import {
  createPr,
  fetchPrOptions,
  fetchPrPreflight,
  generatePrMetadata,
  pushPrBranch,
  resolvePrConflicts,
  type PrOptionsLabel,
  type PrOptionsResponse,
  type PrOptionsUser,
  type PrPreflightResponse,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { FloatingWindow } from "./FloatingWindow";
import "./PrCreateModal.css";

interface PrCreateModalProps {
  open: boolean;
  taskId: string;
  projectId?: string;
  defaultBaseBranch?: string;
  onClose: () => void;
  onCreated: (prInfo: PrInfo) => void;
  addToast: (message: string, type?: ToastType) => void;
}

type ModalGhError = StructuredGhError & { operation: "create" };

type PreflightCheck = {
  key: string;
  label: string;
  ok: boolean;
  message: string;
  warning?: boolean;
};

/*
FNXC:PrCreateModal 2026-06-23-00:00:
The Create PR modal must stay manually usable after metadata generation fails, but non-interactive GitHub PR creation cannot accept a title-only payload. Seed an editable body fallback with the required sections so users can complete or revise the PR instead of submitting an empty body.
*/
function buildManualPrBodyFallback(taskId: string): string {
  return [
    "## Summary",
    "",
    "Summary unavailable. Add context before creating this PR.",
    "",
    "## Changes",
    "",
    "- Details unavailable.",
    "",
    "## Testing",
    "",
    "- Not provided.",
    "",
    "## Linked Task",
    "",
    `Closes ${taskId}`,
  ].join("\n");
}

function OptionChips<T extends { login?: string; name?: string; color?: string }>(
  {
    label,
    options,
    selected,
    onChange,
    getKey,
    getLabel,
    includeColor,
  }: {
    label: string;
    options: T[];
    selected: T[];
    onChange: (next: T[]) => void;
    getKey: (option: T) => string;
    getLabel: (option: T) => string;
    includeColor?: boolean;
  },
) {
  const [query, setQuery] = useState("");
  const available = useMemo(() => options.filter((opt) => !selected.some((value) => getKey(value) === getKey(opt))), [getKey, options, selected]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return available;
    return available.filter((opt) => getLabel(opt).toLowerCase().includes(normalized));
  }, [available, getLabel, query]);

  return (
    <div className="pr-create-modal__section">
      <label className="pr-create-modal__label">{label}</label>
      <div className="pr-create-modal__chips">
        {selected.map((item) => {
          const key = getKey(item);
          const hasColor = Boolean(includeColor && item.color);
          const chipStyle = hasColor
            ? ({ "--pr-chip-label-color": "#" + item.color } as CSSProperties)
            : undefined;
          return (
            <span
              key={key}
              className={`pr-create-modal__chip${hasColor ? " pr-create-modal__chip--colored" : ""}`}
              style={chipStyle}
            >
              <span className="pr-create-modal__chip-label">{getLabel(item)}</span>
              <button
                type="button"
                className="btn btn-icon pr-create-modal__chip-remove"
                onClick={() => onChange(selected.filter((value) => getKey(value) !== key))}
                aria-label={`Remove ${getLabel(item)}`}
              >
                <X size={14} />
              </button>
            </span>
          );
        })}
      </div>
      <input
        className="input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Filter ${label.toLowerCase()}`}
        aria-label={`Filter ${label.toLowerCase()}`}
      />
      {filtered.length > 0 && (
        <div className="pr-create-modal__option-list">
          {filtered.map((item) => (
            <button
              key={getKey(item)}
              type="button"
              className="btn btn-sm pr-create-modal__option-item"
              onClick={() => {
                onChange([...selected, item]);
                setQuery("");
              }}
            >
              {getLabel(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function PrCreateModal({
  open,
  taskId,
  projectId,
  defaultBaseBranch,
  onClose,
  onCreated,
  addToast,
}: PrCreateModalProps) {
  const { t } = useTranslation("app");
  const headingId = useId();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const requestSeqRef = useRef({ metadata: 0, preflight: 0, options: 0 });
  const preflightRef = useRef<PrPreflightResponse | null>(null);
  const optionsRef = useRef<PrOptionsResponse | null>(null);
  const baseBranchTouchedRef = useRef(false);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [pushBranchError, setPushBranchError] = useState<string | null>(null);
  const [resolveConflictError, setResolveConflictError] = useState<string | null>(null);
  const [lastGhError, setLastGhError] = useState<ModalGhError | null>(null);
  const [aiTitle, setAiTitle] = useState("");
  const [aiBody, setAiBody] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [userEditedTitle, setUserEditedTitle] = useState(false);
  const [userEditedBody, setUserEditedBody] = useState(false);
  const [templateUsed, setTemplateUsed] = useState(false);
  const [options, setOptions] = useState<PrOptionsResponse | null>(null);
  const [preflight, setPreflight] = useState<PrPreflightResponse | null>(null);
  const [baseBranch, setBaseBranch] = useState("");
  const [draft, setDraft] = useState(false);
  const [pushingBranch, setPushingBranch] = useState(false);
  const [resolvingConflicts, setResolvingConflicts] = useState(false);
  const [reviewers, setReviewers] = useState<PrOptionsUser[]>([]);
  const [assignees, setAssignees] = useState<PrOptionsUser[]>([]);
  const [labels, setLabels] = useState<PrOptionsLabel[]>([]);

  const applyPreferredBase = useCallback((baseOverride?: string, nextPreflight?: PrPreflightResponse | null, nextOptions?: PrOptionsResponse | null) => {
    if (baseBranchTouchedRef.current) {
      return;
    }
    const preferredBase = baseOverride
      ?? defaultBaseBranch
      ?? nextPreflight?.defaultBaseBranch
      ?? nextOptions?.baseBranches[0]
      ?? "";
    setBaseBranch(preferredBase);
  }, [defaultBaseBranch]);

  const loadMetadata = useCallback(async (resetContent = false) => {
    const requestId = ++requestSeqRef.current.metadata;
    setMetadataLoading(true);
    setMetadataError(null);
    if (resetContent) {
      setAiTitle("");
      setAiBody("");
      setTitle("");
      setBody("");
      setTemplateUsed(false);
      setUserEditedTitle(false);
      setUserEditedBody(false);
    }
    try {
      const metadata = await generatePrMetadata(taskId, projectId);
      if (requestId !== requestSeqRef.current.metadata) {
        return;
      }
      setAiTitle(metadata.title);
      setAiBody(metadata.body);
      setTitle((current) => (current.trim() ? current : metadata.title));
      setBody((current) => (current.trim() ? current : metadata.body));
      setTemplateUsed(metadata.templateUsed);
    } catch (loadError) {
      if (requestId === requestSeqRef.current.metadata) {
        setMetadataError(getErrorMessage(loadError));
        setBody((current) => (current.trim() ? current : buildManualPrBodyFallback(taskId)));
        setAiBody((current) => current || buildManualPrBodyFallback(taskId));
      }
    } finally {
      if (requestId === requestSeqRef.current.metadata) {
        setMetadataLoading(false);
      }
    }
  }, [projectId, taskId]);

  const loadPreflight = useCallback(async (baseOverride?: string, resetData = false) => {
    const requestId = ++requestSeqRef.current.preflight;
    setPreflightLoading(true);
    setPreflightError(null);
    setPushBranchError(null);
    setResolveConflictError(null);
    if (resetData) {
      preflightRef.current = null;
      setPreflight(null);
    }
    try {
      const preflightData = await fetchPrPreflight(taskId, projectId, baseOverride);
      if (requestId !== requestSeqRef.current.preflight) {
        return;
      }
      preflightRef.current = preflightData;
      setPreflight(preflightData);
      applyPreferredBase(baseOverride, preflightData, optionsRef.current);
    } catch (loadError) {
      if (requestId === requestSeqRef.current.preflight) {
        setPreflightError(getErrorMessage(loadError));
      }
    } finally {
      if (requestId === requestSeqRef.current.preflight) {
        setPreflightLoading(false);
      }
    }
  }, [applyPreferredBase, projectId, taskId]);

  const loadOptions = useCallback(async (resetData = false) => {
    const requestId = ++requestSeqRef.current.options;
    setOptionsLoading(true);
    setOptionsError(null);
    if (resetData) {
      optionsRef.current = null;
      setOptions(null);
    }
    try {
      const optionsData = await fetchPrOptions(taskId, projectId);
      if (requestId !== requestSeqRef.current.options) {
        return;
      }
      optionsRef.current = optionsData;
      setOptions(optionsData);
      applyPreferredBase(undefined, preflightRef.current, optionsData);
    } catch (loadError) {
      if (requestId === requestSeqRef.current.options) {
        setOptionsError(getErrorMessage(loadError));
      }
    } finally {
      if (requestId === requestSeqRef.current.options) {
        setOptionsLoading(false);
      }
    }
  }, [applyPreferredBase, projectId, taskId]);

  const loadData = useCallback((baseOverride?: string) => {
    baseBranchTouchedRef.current = false;
    setSubmitError(null);
    setLastGhError(null);
    setPushBranchError(null);
    setResolveConflictError(null);
    setDraft(false);
    setReviewers([]);
    setAssignees([]);
    setLabels([]);
    setBaseBranch("");
    void loadMetadata(true);
    void loadPreflight(baseOverride, true);
    void loadOptions(true);
  }, [loadMetadata, loadOptions, loadPreflight]);

  useEffect(() => {
    if (!open) return;
    loadData();
    return () => {
      requestSeqRef.current.metadata += 1;
      requestSeqRef.current.preflight += 1;
      requestSeqRef.current.options += 1;
    };
  }, [loadData, open]);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = modalRef.current?.querySelector<HTMLElement>("input, textarea, select, button, [tabindex]:not([tabindex='-1'])");
    focusable?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !modalRef.current) return;
      const elements = Array.from(modalRef.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"));
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, [onClose, open]);

  const regenerate = useCallback(async () => {
    const requestId = ++requestSeqRef.current.metadata;
    setMetadataLoading(true);
    setMetadataError(null);
    try {
      const metadata = await generatePrMetadata(taskId, projectId);
      if (requestId !== requestSeqRef.current.metadata) {
        return;
      }
      setAiTitle(metadata.title);
      setAiBody(metadata.body);
      setTitle(metadata.title);
      setBody(metadata.body);
      setTemplateUsed(metadata.templateUsed);
      setUserEditedTitle(false);
      setUserEditedBody(false);
    } catch (regenerateError) {
      if (requestId === requestSeqRef.current.metadata) {
        setMetadataError(getErrorMessage(regenerateError));
        setBody((current) => (current.trim() ? current : buildManualPrBodyFallback(taskId)));
        setAiBody((current) => current || buildManualPrBodyFallback(taskId));
      }
    } finally {
      if (requestId === requestSeqRef.current.metadata) {
        setMetadataLoading(false);
      }
    }
  }, [projectId, taskId]);

  const checks = useMemo<PreflightCheck[]>(() => {
    if (!preflight) return [];
    return [
      {
        key: "branch",
        label: t("pr.checkBranch", "Branch pushed to remote"),
        ok: preflight.branchOnRemote,
        message: preflight.branchOnRemote ? t("pr.branchRemoteOk", "Remote branch is available.") : t("pr.branchRemoteFail", "Push branch to remote before creating a PR."),
      },
      {
        key: "commits",
        label: t("pr.checkCommits", "Commits available"),
        ok: preflight.commitsPresent,
        message: preflight.commitsPresent ? t("pr.commitsOk", "Commits are ready to submit.") : t("pr.commitsFail", "No commits found for this branch."),
      },
      {
        key: "conflicts",
        label: t("pr.checkConflicts", "No conflicts with base"),
        ok: !preflight.conflictsWithBase,
        warning: preflight.conflictsWithBase,
        message: preflight.conflictsWithBase ? t("pr.conflictsDetected", "Conflicts detected. Resolve conflicts or re-run preflight.") : t("pr.noConflicts", "No merge conflicts detected."),
      },
      {
        key: "auth",
        label: t("pr.checkAuth", "GitHub auth available"),
        ok: preflight.ghAuthOk,
        message: preflight.ghAuthOk ? t("pr.authOk", "GitHub CLI auth is available.") : t("pr.authFail", "Run gh auth login and try again."),
      },
    ];
  }, [preflight, t]);

  const canSubmit = useMemo(() => checks.every((check) => check.ok), [checks]);

  const handleBaseChange = useCallback(async (nextBase: string) => {
    baseBranchTouchedRef.current = true;
    setBaseBranch(nextBase);
    setPushBranchError(null);
    setResolveConflictError(null);
    await loadPreflight(nextBase);
  }, [loadPreflight]);

  const handlePushBranch = useCallback(async () => {
    if (!baseBranch || pushingBranch) return;
    setPushingBranch(true);
    setPushBranchError(null);
    try {
      const response = await pushPrBranch(taskId, baseBranch, projectId);
      preflightRef.current = response.preflight;
      setPreflight(response.preflight);
      setPreflightError(null);
      addToast(response.result.message, "success");
    } catch (pushError) {
      setPushBranchError(getErrorMessage(pushError));
    } finally {
      setPushingBranch(false);
    }
  }, [addToast, baseBranch, projectId, pushingBranch, taskId]);

  const handleResolveConflicts = useCallback(async () => {
    if (!baseBranch || resolvingConflicts) return;
    setResolvingConflicts(true);
    setResolveConflictError(null);
    try {
      const response = await resolvePrConflicts(taskId, baseBranch, projectId);
      preflightRef.current = response.preflight;
      setPreflight(response.preflight);
      setPreflightError(null);
      addToast("Resolved PR conflicts and pushed branch", "success");
    } catch (resolveError) {
      setResolveConflictError(getErrorMessage(resolveError));
    } finally {
      setResolvingConflicts(false);
    }
  }, [addToast, baseBranch, projectId, resolvingConflicts, taskId]);

  const payload = useMemo(() => ({
    title: title.trim(),
    body: body.trim(),
    base: baseBranch || undefined,
    draft,
    reviewers: reviewers.map((value) => value.login),
    assignees: assignees.map((value) => value.login),
    labels: labels.map((value) => value.name),
  }), [assignees, baseBranch, body, draft, labels, reviewers, title]);

  const submit = useCallback(async () => {
    if (!payload.title || !payload.body || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setLastGhError(null);
    try {
      const prInfo = await createPr(taskId, payload, projectId);
      onCreated(prInfo);
      addToast(`Created PR #${prInfo.number}`, "success");
      onClose();
    } catch (submitError) {
      const details = (submitError as { details?: { githubError?: StructuredGhError } })?.details?.githubError;
      const structured: ModalGhError = details
        ? { ...details, operation: "create" }
        : { code: "unknown", message: getErrorMessage(submitError), retryable: true, action: { kind: "retry" }, operation: "create" };
      setLastGhError(structured);
      setSubmitError(structured.message);
    } finally {
      setSubmitting(false);
    }
  }, [addToast, onClose, onCreated, payload, projectId, submitting, taskId]);

  const hasRequiredPrContent = title.trim().length > 0 && body.trim().length > 0;

  if (!open) return null;

  return (
    <FloatingWindow
      windowKey="pr-create"
      title={t("pr.createTitle", "Create Pull Request")}
      onClose={onClose}
      hideHeader
      dragHandleSelector=".pr-create-modal__drag-handle"
      className="floating-window--pr-create"
      defaultSize={{ width: 720, height: 680 }}
      minSize={{ width: 480, height: 420 }}
      persistGeometryKey="floating-window:pr-create"
    >
      {/**
       * FNXC:PrCreateModal 2026-06-27-00:00:
       * FN-7170 moves Create PR onto the shared FloatingWindow shell so it matches Plan Mission, Automations, and New Task: desktop users can drag the embedded modal header and resize from every FloatingWindow edge/corner, mobile stays full-screen through CSS, and geometry persists with persistGeometryKey="floating-window:pr-create". Overlay click-to-dismiss is intentionally dropped because FloatingWindow is non-blocking/click-through; close remains available via X, Cancel, and Escape.
       */}
      <div
        ref={modalRef}
        className="modal modal-lg pr-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="modal-header pr-create-modal__drag-handle">
          <h2 id={headingId}>{t("pr.createTitle", "Create Pull Request")}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t("actions.close", "Close")}>
            <X size={20} />
          </button>
        </div>

        <div className="pr-create-modal__body">
          <>
            <section className="pr-create-modal__section">
              <h3 className="pr-create-modal__section-title">{t("pr.preflightChecks", "Pre-flight checks")}</h3>
              {preflightLoading ? <div className="pr-create-modal__loading pr-create-modal__section-loading"><span className="status-dot status-dot--pending" aria-hidden="true" />{t("pr.loadingPreflight", "Loading pre-flight checks…")}</div> : null}
              {preflightError ? <div className="form-error pr-error" role="alert"><p>{preflightError}</p></div> : null}
              {!preflightLoading && !preflightError ? (
                <>
                  <div className="pr-create-modal__preflight">
                    {checks.map((check) => (
                      <div key={check.key} className={`pr-create-modal__preflight-row ${check.ok ? "is-ok" : "is-failed"}`}>
                        <span className={`status-dot ${check.ok ? "status-dot--online" : check.warning ? "status-dot--pending" : "status-dot--error"}`} aria-hidden="true" />
                        {check.ok ? <CheckCircle2 size={16} /> : check.warning ? <AlertTriangle size={16} /> : <XCircle size={16} />}
                        <div>
                          <p className="pr-create-modal__preflight-label">{check.label}</p>
                          <p className="pr-create-modal__preflight-message">{check.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => void handleBaseChange(baseBranch)} disabled={preflightLoading}>
                    {preflightLoading ? <RefreshCw size={14} className="spin" /> : null}
                    {t("pr.rerunPreflight", "Re-run preflight")}
                  </button>
                  {!preflight?.branchOnRemote ? (
                    <div className="card pr-create-modal__preflight-remediation">
                      <div className="pr-create-modal__conflict-copy">
                        <p className="pr-create-modal__conflict-title">{t("pr.pushBranch.title", "Push branch to remote")}</p>
                        <p className="pr-create-modal__conflict-message">{t("pr.pushBranch.message", "Fusion will push this task's branch to origin so the PR can be created.")}</p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handlePushBranch()}
                        disabled={pushingBranch || preflightLoading || !baseBranch}
                      >
                        {pushingBranch ? <RefreshCw size={14} className="spin" /> : null}
                        {t("pr.pushBranch.button", "Push branch to remote")}
                      </button>
                    </div>
                  ) : null}
                  {preflight?.conflictsWithBase ? (
                    <div className="card pr-create-modal__conflict-resolution">
                      <div className="pr-create-modal__conflict-copy">
                        <p className="pr-create-modal__conflict-title">{t("pr.resolveConflicts.title", "Resolve conflicts with AI")}</p>
                        <p className="pr-create-modal__conflict-message">{t("pr.resolveConflicts.message", "Fusion will use AI to resolve conflicts on this branch and push it.")}</p>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void handleResolveConflicts()}
                        disabled={resolvingConflicts || preflightLoading || !baseBranch}
                      >
                        {resolvingConflicts ? <RefreshCw size={14} className="spin" /> : null}
                        {t("pr.resolveConflicts.button", "Resolve conflicts with AI")}
                      </button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>

            <section className="pr-create-modal__section">
              <div className="pr-create-modal__title-row">
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-title">{t("pr.titleLabel", "Title")}</label>
                <div className="pr-create-modal__inline-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void regenerate()} disabled={metadataLoading}><Sparkles size={14} />{t("pr.regenerate", "Regenerate")}</button>
                  {userEditedTitle && <button type="button" className="btn btn-sm" onClick={() => { setTitle(aiTitle); setUserEditedTitle(false); }}>{t("pr.revertToAi", "Revert to AI version")}</button>}
                </div>
              </div>
              {metadataLoading ? <div className="pr-create-modal__loading pr-create-modal__section-loading"><span className="status-dot status-dot--pending" aria-hidden="true" />{t("pr.generatingTitle", "Generating AI title…")}</div> : null}
              {metadataError ? <div className="form-error pr-error" role="alert"><p>{metadataError}</p></div> : null}
              <input id="pr-create-modal-title" className="input" value={title} onChange={(event) => { setTitle(event.target.value); setUserEditedTitle(true); }} />
            </section>

            <section className="pr-create-modal__section">
              <div className="pr-create-modal__title-row">
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-body">{t("pr.bodyLabel", "Body")}</label>
                <div className="pr-create-modal__inline-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void regenerate()} disabled={metadataLoading}><Sparkles size={14} />{t("pr.regenerate", "Regenerate")}</button>
                  {userEditedBody && <button type="button" className="btn btn-sm" onClick={() => { setBody(aiBody); setUserEditedBody(false); }}>{t("pr.revertToAi", "Revert to AI version")}</button>}
                </div>
              </div>
              {metadataLoading ? <div className="pr-create-modal__loading pr-create-modal__section-loading"><span className="status-dot status-dot--pending" aria-hidden="true" />{t("pr.generatingBody", "Generating AI body…")}</div> : null}
              <textarea id="pr-create-modal-body" className="input pr-create-modal__body-input" value={body} onChange={(event) => { setBody(event.target.value); setUserEditedBody(true); }} rows={8} />
              {templateUsed && <p className="pr-create-template-hint">{t("pr.usingTemplate", "Using <code>.github/pull_request_template.md</code>")}</p>}
            </section>

            <section className="pr-create-modal__section pr-create-modal__grid-two">
              <div>
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-base">{t("pr.baseBranch", "Base branch")}</label>
                {optionsLoading ? <div className="pr-create-modal__loading pr-create-modal__section-loading"><span className="status-dot status-dot--pending" aria-hidden="true" />{t("pr.loadingOptions", "Loading PR options…")}</div> : null}
                {optionsError ? <div className="form-error pr-error" role="alert"><p>{optionsError}</p></div> : null}
                <select id="pr-create-modal-base" className="select" value={baseBranch} onChange={(event) => void handleBaseChange(event.target.value)} disabled={optionsLoading || Boolean(optionsError) || (options?.baseBranches?.length ?? 0) === 0}>
                  {(options?.baseBranches ?? []).map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </div>
              <label className="checkbox-label pr-create-modal__draft">
                <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
                {t("pr.createAsDraft", "Create as draft")}
              </label>
            </section>

            <OptionChips
              label={t("pr.reviewers", "Reviewers")}
              options={options?.reviewers ?? []}
              selected={reviewers}
              onChange={setReviewers}
              getKey={(option) => option.login}
              getLabel={(option) => option.name ? `${option.name} (@${option.login})` : `@${option.login}`}
            />
            <OptionChips
              label={t("pr.assignees", "Assignees")}
              options={options?.assignees ?? []}
              selected={assignees}
              onChange={setAssignees}
              getKey={(option) => option.login}
              getLabel={(option) => option.name ? `${option.name} (@${option.login})` : `@${option.login}`}
            />
            <OptionChips
              label={t("pr.labels", "Labels")}
              options={options?.labels ?? []}
              selected={labels}
              onChange={setLabels}
              getKey={(option) => option.name}
              getLabel={(option) => option.name}
              includeColor
            />

            <details className="pr-create-collapsible" open>
              <summary>{t("pr.previewTitle", "Diff & commit preview")}</summary>
              <div className="pr-create-modal__preview">
                <h4>{t("pr.commitsLabel", "Commits")}</h4>
                {!preflightLoading && !preflightError && (preflight?.commits?.length ?? 0) === 0 ? <p className="pr-create-template-hint">{t("pr.noCommits", "No commits found.")}</p> : null}
                {(preflight?.commits ?? []).map((commit) => (
                  <div className="pr-create-modal__commit-row" key={commit.sha}>
                    <code>{commit.sha.slice(0, 7)}</code>
                    <span>{commit.subject}</span>
                    <span>{commit.author}</span>
                  </div>
                ))}
                <h4>{t("pr.changedFilesLabel", "Changed files")}</h4>
                {!preflightLoading && !preflightError && (preflight?.changedFiles?.length ?? 0) === 0 ? <p className="pr-create-template-hint">{t("pr.noChangedFiles", "No changed files detected.")}</p> : null}
                {(preflight?.changedFiles ?? []).map((file) => (
                  <div className="pr-create-modal__file-row" key={file.path}>
                    <span>{file.path}</span>
                    <span>+{file.additions} / −{file.deletions}</span>
                    <span className={`card-status-badge card-status-badge--${file.status === "added" ? "done" : file.status === "deleted" ? "archived" : file.status === "renamed" ? "in-review" : "todo"}`}>{file.status}</span>
                  </div>
                ))}
              </div>
            </details>

            {pushBranchError ? (
              <div className="form-error pr-error" role="alert">
                <p>{pushBranchError}</p>
                <div className="pr-error__actions">
                  <button type="button" className="btn btn-sm pr-error__dismiss" onClick={() => setPushBranchError(null)} aria-label={t("pr.dismissPushBranchError", "Dismiss push branch error")}>×</button>
                </div>
              </div>
            ) : null}

            {resolveConflictError ? (
              <div className="form-error pr-error" role="alert">
                <p>{resolveConflictError}</p>
                <div className="pr-error__actions">
                  <button type="button" className="btn btn-sm pr-error__dismiss" onClick={() => setResolveConflictError(null)} aria-label={t("pr.dismissConflictResolutionError", "Dismiss conflict resolution error")}>×</button>
                </div>
              </div>
            ) : null}

            {submitError && (
              <div className="form-error pr-error" role="alert">
                <p>{submitError}</p>
                {lastGhError?.hint ? <p className="pr-error__hint">{lastGhError.hint}</p> : null}
                <div className="pr-error__actions">
                  {lastGhError?.action?.kind === "shell" ? <p>{t("pr.error.actionRun", "Action: run")} <code>{lastGhError.action.command}</code></p> : null}
                  {lastGhError?.action?.kind === "open" ? <p>{t("pr.error.actionOpen", "Action: open")} <a href={lastGhError.action.url} target="_blank" rel="noreferrer">{t("pr.error.docs", "docs")}</a></p> : null}
                  {lastGhError?.retryable ? <button type="button" className="btn btn-sm pr-error__retry" onClick={() => void submit()}>{t("actions.retry", "Retry")}</button> : null}
                  <button type="button" className="btn btn-sm pr-error__dismiss" onClick={() => { setLastGhError(null); setSubmitError(null); }} aria-label={t("pr.dismissError", "Dismiss PR error")}>×</button>
                </div>
              </div>
            )}
          </>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>{t("actions.cancel", "Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!preflight || preflightLoading || !canSubmit || !hasRequiredPrContent || submitting}>
            {submitting ? <RefreshCw size={14} className="spin" /> : null}
            {draft ? t("pr.createDraftPr", "Create draft PR") : t("pr.createPr", "Create PR")}
          </button>
        </div>
      </div>
    </FloatingWindow>
  );
}
