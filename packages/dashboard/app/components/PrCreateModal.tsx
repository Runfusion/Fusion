import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { AlertTriangle, CheckCircle2, RefreshCw, Sparkles, X, XCircle } from "lucide-react";
import { getErrorMessage, type PrInfo, type StructuredGhError } from "@fusion/core";
import {
  createPr,
  fetchPrOptions,
  fetchPrPreflight,
  generatePrMetadata,
  type PrOptionsLabel,
  type PrOptionsResponse,
  type PrOptionsUser,
  type PrPreflightResponse,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
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
  const headingId = useId();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const requestSeqRef = useRef(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const [reviewers, setReviewers] = useState<PrOptionsUser[]>([]);
  const [assignees, setAssignees] = useState<PrOptionsUser[]>([]);
  const [labels, setLabels] = useState<PrOptionsLabel[]>([]);

  useModalResizePersist(modalRef, open, "fusion:pr-create-modal-size");

  const loadData = useCallback(async (baseOverride?: string) => {
    const requestId = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const [metadata, preflightData, optionsData] = await Promise.all([
        generatePrMetadata(taskId, projectId),
        fetchPrPreflight(taskId, projectId, baseOverride),
        fetchPrOptions(taskId, projectId),
      ]);
      if (requestId !== requestSeqRef.current) {
        return;
      }
      setAiTitle(metadata.title);
      setAiBody(metadata.body);
      setTitle((current) => (current || metadata.title));
      setBody((current) => (current || metadata.body));
      setTemplateUsed(metadata.templateUsed);
      setPreflight(preflightData);
      setOptions(optionsData);
      const preferredBase = baseOverride
        ?? defaultBaseBranch
        ?? preflightData.defaultBaseBranch
        ?? optionsData.baseBranches[0]
        ?? "";
      setBaseBranch(preferredBase);
    } catch (loadError) {
      if (requestId === requestSeqRef.current) {
        setError(getErrorMessage(loadError));
      }
    } finally {
      if (requestId === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [defaultBaseBranch, projectId, taskId]);

  useEffect(() => {
    if (!open) return;
    void loadData();
    return () => {
      requestSeqRef.current += 1;
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
    try {
      const metadata = await generatePrMetadata(taskId, projectId);
      setAiTitle(metadata.title);
      setAiBody(metadata.body);
      setTitle(metadata.title);
      setBody(metadata.body);
      setTemplateUsed(metadata.templateUsed);
      setUserEditedTitle(false);
      setUserEditedBody(false);
    } catch (regenerateError) {
      setError(getErrorMessage(regenerateError));
    }
  }, [projectId, taskId]);

  const checks = useMemo<PreflightCheck[]>(() => {
    if (!preflight) return [];
    return [
      {
        key: "branch",
        label: "Branch pushed to remote",
        ok: preflight.branchOnRemote,
        message: preflight.branchOnRemote ? "Remote branch is available." : "Push branch to remote before creating a PR.",
      },
      {
        key: "commits",
        label: "Commits available",
        ok: preflight.commitsPresent,
        message: preflight.commitsPresent ? "Commits are ready to submit." : "No commits found for this branch.",
      },
      {
        key: "conflicts",
        label: "No conflicts with base",
        ok: !preflight.conflictsWithBase,
        warning: preflight.conflictsWithBase,
        message: preflight.conflictsWithBase ? "Conflicts detected. Resolve conflicts or re-run preflight." : "No merge conflicts detected.",
      },
      {
        key: "auth",
        label: "GitHub auth available",
        ok: preflight.ghAuthOk,
        message: preflight.ghAuthOk ? "GitHub CLI auth is available." : "Run gh auth login and try again.",
      },
    ];
  }, [preflight]);

  const canSubmit = useMemo(() => checks.every((check) => check.ok), [checks]);

  const handleBaseChange = useCallback(async (nextBase: string) => {
    setBaseBranch(nextBase);
    try {
      const nextPreflight = await fetchPrPreflight(taskId, projectId, nextBase);
      setPreflight(nextPreflight);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }, [projectId, taskId]);

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
    if (!payload.title || submitting) return;
    setSubmitting(true);
    setError(null);
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
      setError(structured.message);
    } finally {
      setSubmitting(false);
    }
  }, [addToast, onClose, onCreated, payload, projectId, submitting, taskId]);

  if (!open) return null;

  return (
    <div className="modal-overlay open" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={modalRef}
        className="modal modal-lg pr-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <div className="modal-header">
          <h2 id={headingId}>Create Pull Request</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close create pull request modal">
            <X size={20} />
          </button>
        </div>

        <div className="pr-create-modal__body">
          {loading ? <div className="pr-create-modal__loading">Loading PR metadata…</div> : (
            <>
              <section className="pr-create-modal__section">
              <h3 className="pr-create-modal__section-title">Pre-flight checks</h3>
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
              <button type="button" className="btn btn-sm" onClick={() => void handleBaseChange(baseBranch)}>
                Re-run preflight
              </button>
            </section>

            <section className="pr-create-modal__section">
              <div className="pr-create-modal__title-row">
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-title">Title</label>
                <div className="pr-create-modal__inline-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void regenerate()}><Sparkles size={14} />Regenerate</button>
                  {userEditedTitle && <button type="button" className="btn btn-sm" onClick={() => { setTitle(aiTitle); setUserEditedTitle(false); }}>Revert to AI version</button>}
                </div>
              </div>
              <input id="pr-create-modal-title" className="input" value={title} onChange={(event) => { setTitle(event.target.value); setUserEditedTitle(true); }} />
            </section>

            <section className="pr-create-modal__section">
              <div className="pr-create-modal__title-row">
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-body">Body</label>
                <div className="pr-create-modal__inline-actions">
                  <button type="button" className="btn btn-sm" onClick={() => void regenerate()}><Sparkles size={14} />Regenerate</button>
                  {userEditedBody && <button type="button" className="btn btn-sm" onClick={() => { setBody(aiBody); setUserEditedBody(false); }}>Revert to AI version</button>}
                </div>
              </div>
              <textarea id="pr-create-modal-body" className="input pr-create-modal__body-input" value={body} onChange={(event) => { setBody(event.target.value); setUserEditedBody(true); }} rows={8} />
              {templateUsed && <p className="pr-create-template-hint">Using <code>.github/pull_request_template.md</code></p>}
            </section>

            <section className="pr-create-modal__section pr-create-modal__grid-two">
              <div>
                <label className="pr-create-modal__label" htmlFor="pr-create-modal-base">Base branch</label>
                <select id="pr-create-modal-base" className="select" value={baseBranch} onChange={(event) => void handleBaseChange(event.target.value)}>
                  {(options?.baseBranches ?? []).map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </div>
              <label className="checkbox-label pr-create-modal__draft">
                <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
                Create as draft
              </label>
            </section>

            <OptionChips
              label="Reviewers"
              options={options?.reviewers ?? []}
              selected={reviewers}
              onChange={setReviewers}
              getKey={(option) => option.login}
              getLabel={(option) => option.name ? `${option.name} (@${option.login})` : `@${option.login}`}
            />
            <OptionChips
              label="Assignees"
              options={options?.assignees ?? []}
              selected={assignees}
              onChange={setAssignees}
              getKey={(option) => option.login}
              getLabel={(option) => option.name ? `${option.name} (@${option.login})` : `@${option.login}`}
            />
            <OptionChips
              label="Labels"
              options={options?.labels ?? []}
              selected={labels}
              onChange={setLabels}
              getKey={(option) => option.name}
              getLabel={(option) => option.name}
              includeColor
            />

            <details className="pr-create-collapsible" open>
              <summary>Diff & commit preview</summary>
              <div className="pr-create-modal__preview">
                <h4>Commits</h4>
                {(preflight?.commits ?? []).map((commit) => (
                  <div className="pr-create-modal__commit-row" key={commit.sha}>
                    <code>{commit.sha.slice(0, 7)}</code>
                    <span>{commit.subject}</span>
                    <span>{commit.author}</span>
                  </div>
                ))}
                <h4>Changed files</h4>
                {(preflight?.changedFiles ?? []).map((file) => (
                  <div className="pr-create-modal__file-row" key={file.path}>
                    <span>{file.path}</span>
                    <span>+{file.additions} / −{file.deletions}</span>
                    <span className={`card-status-badge card-status-badge--${file.status === "added" ? "done" : file.status === "deleted" ? "archived" : file.status === "renamed" ? "in-review" : "todo"}`}>{file.status}</span>
                  </div>
                ))}
              </div>
            </details>

              {error && (
                <div className="form-error pr-error" role="alert">
                  <p>{error}</p>
                  {lastGhError?.hint ? <p className="pr-error__hint">{lastGhError.hint}</p> : null}
                  <div className="pr-error__actions">
                    {lastGhError?.action?.kind === "shell" ? <p>Action: run <code>{lastGhError.action.command}</code></p> : null}
                    {lastGhError?.action?.kind === "open" ? <p>Action: open <a href={lastGhError.action.url} target="_blank" rel="noreferrer">docs</a></p> : null}
                    {lastGhError?.retryable ? <button type="button" className="btn btn-sm pr-error__retry" onClick={() => void submit()}>Retry</button> : null}
                    <button type="button" className="btn btn-sm pr-error__dismiss" onClick={() => { setLastGhError(null); setError(null); }} aria-label="Dismiss PR error">×</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={!canSubmit || !title.trim() || submitting || loading}>
            {submitting ? <RefreshCw size={14} className="spin" /> : null}
            {draft ? "Create draft PR" : "Create PR"}
          </button>
        </div>
      </div>
    </div>
  );
}
