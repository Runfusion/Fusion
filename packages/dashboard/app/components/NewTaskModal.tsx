import "./NewTaskModal.css";
import { useState, useCallback, useEffect, useRef, type CSSProperties, type ChangeEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { DEFAULT_TASK_PRIORITY, type Task, type TaskPriority } from "@fusion/core";
import { getErrorMessage } from "@fusion/core";
import type { ToastType } from "../hooks/useToast";
import {
  apiFetchGitHubIssues,
  apiFetchGitHubPulls,
  checkDuplicateTasks,
  fetchGitRemotes,
  uploadAttachment,
  type CreateTaskInput,
  type DuplicateMatch,
  type GitHubIssue,
  type GitHubPull,
  type GitRemote,
} from "../api";
import { Bot } from "lucide-react";
import { useSetupReadiness } from "../hooks/useSetupReadiness";
import { SetupWarningBanner } from "./SetupWarningBanner";
import { LoadingSpinner } from "./LoadingSpinner";
import { TaskForm, type BranchSelectionMode, type EnabledWorkflowStepsChangeMeta, type PendingImage } from "./TaskForm";
import { DuplicateWarningModal } from "./DuplicateWarningModal";
import { REPO_OVERRIDE_RE } from "./githubTracking";
import { useConfirm } from "../hooks/useConfirm";
import { useMobileKeyboard } from "../hooks/useMobileKeyboard";
import { useMobileScrollLock } from "../hooks/useMobileScrollLock";
import { useNodes } from "../hooks/useNodes";
import { useViewportMode } from "../hooks/useViewportMode";
import { useAgentsMapCache } from "../hooks/useAgentsMapCache";
import { nextFloatingZ, currentFloatingZ } from "./floatingWindowStack";

type NewTaskCreateInput = Omit<CreateTaskInput, "branchSelection"> & {
  branchSelection?: {
    mode: BranchSelectionMode;
    branchName?: string;
    baseBranch?: string;
  };
};

interface NewTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId?: string;
  tasks: Task[]; // for dependency selection
  onCreateTask: (input: NewTaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
  initialDescription?: string;
  onPlanningMode?: (initialPlan: string, workflowId?: string | null) => void;
  onSubtaskBreakdown?: (description: string, workflowId?: string | null) => void;
}

/*
FNXC:NewTask 2026-06-22-20:30:
The New Task dialog is a FLOATING, DRAGGABLE, RESIZABLE, NON-BLOCKING window matching the right-dock pop-out (RightDockExpandModal). The overlay is transparent and `pointer-events: none` so the app behind stays usable and behind-clicks pass through — there is therefore NO overlay click-to-dismiss; the header close (X) and Cancel button are the only dismissals (plus Escape). The panel is `position: fixed; pointer-events: auto`, dragged by its header and resized from corner/edge handles, with rAF-batched position/size state and a single teardown ref invoked on pointerup/pointercancel AND on unmount so no document/element listeners or pending rAF leak. Size/position persist to localStorage. On mobile we keep the full-screen sheet behavior (no floating) so the keyboard-aware layout still works.
*/
const NEW_TASK_MODAL_SIZE_STORAGE_KEY = "fusion:new-task-modal-size";
const NEW_TASK_MODAL_POSITION_STORAGE_KEY = "fusion:new-task-modal-position";

const NEW_TASK_DEFAULT_WIDTH = 720;
const NEW_TASK_DEFAULT_HEIGHT = 640;
const NEW_TASK_MIN_WIDTH = 420;
const NEW_TASK_MIN_HEIGHT = 360;
const NEW_TASK_VIEWPORT_PADDING = 16;

interface FloatSize {
  width: number;
  height: number;
}

interface FloatPosition {
  x: number;
  y: number;
}

function clampFloatSize(size: FloatSize): FloatSize {
  if (typeof window === "undefined") return size;
  return {
    width: Math.min(Math.max(size.width, NEW_TASK_MIN_WIDTH), Math.max(NEW_TASK_MIN_WIDTH, window.innerWidth - NEW_TASK_VIEWPORT_PADDING * 2)),
    height: Math.min(Math.max(size.height, NEW_TASK_MIN_HEIGHT), Math.max(NEW_TASK_MIN_HEIGHT, window.innerHeight - NEW_TASK_VIEWPORT_PADDING * 2)),
  };
}

function clampFloatPosition(position: FloatPosition, size: FloatSize): FloatPosition {
  if (typeof window === "undefined") return position;
  return {
    x: Math.min(Math.max(position.x, NEW_TASK_VIEWPORT_PADDING), Math.max(NEW_TASK_VIEWPORT_PADDING, window.innerWidth - size.width - NEW_TASK_VIEWPORT_PADDING)),
    y: Math.min(Math.max(position.y, NEW_TASK_VIEWPORT_PADDING), Math.max(NEW_TASK_VIEWPORT_PADDING, window.innerHeight - size.height - NEW_TASK_VIEWPORT_PADDING)),
  };
}

function readFloatSize(): FloatSize {
  if (typeof window === "undefined") return { width: NEW_TASK_DEFAULT_WIDTH, height: NEW_TASK_DEFAULT_HEIGHT };
  try {
    const raw = window.localStorage.getItem(NEW_TASK_MODAL_SIZE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FloatSize>;
      if (typeof parsed.width === "number" && typeof parsed.height === "number") {
        return clampFloatSize({ width: parsed.width, height: parsed.height });
      }
    }
  } catch {
    // ignore corrupted persisted size
  }
  return clampFloatSize({ width: NEW_TASK_DEFAULT_WIDTH, height: NEW_TASK_DEFAULT_HEIGHT });
}

function writeFloatSize(size: FloatSize): FloatSize {
  const clamped = clampFloatSize(size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(NEW_TASK_MODAL_SIZE_STORAGE_KEY, JSON.stringify(clamped));
  }
  return clamped;
}

function readFloatPosition(size: FloatSize): FloatPosition {
  if (typeof window === "undefined") return { x: NEW_TASK_VIEWPORT_PADDING, y: NEW_TASK_VIEWPORT_PADDING };
  try {
    const raw = window.localStorage.getItem(NEW_TASK_MODAL_POSITION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<FloatPosition>;
      if (typeof parsed.x === "number" && typeof parsed.y === "number") {
        return clampFloatPosition({ x: parsed.x, y: parsed.y }, size);
      }
    }
  } catch {
    // ignore corrupted persisted position
  }
  // Default: roughly centered.
  return clampFloatPosition({ x: (window.innerWidth - size.width) / 2, y: (window.innerHeight - size.height) / 2 }, size);
}

function writeFloatPosition(position: FloatPosition, size: FloatSize): FloatPosition {
  const clamped = clampFloatPosition(position, size);
  if (typeof window !== "undefined") {
    window.localStorage.setItem(NEW_TASK_MODAL_POSITION_STORAGE_KEY, JSON.stringify(clamped));
  }
  return clamped;
}

type FloatResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const NEW_TASK_RESIZE_DIRECTIONS: FloatResizeDirection[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
const NEW_TASK_GITHUB_REFERENCE_LIMIT = 30;

type GitHubReferenceOption =
  | { type: "issue"; number: number; title: string; url: string }
  | { type: "pull"; number: number; title: string; url: string };

function buildGitHubReferenceValue(option: GitHubReferenceOption): string {
  return `${option.type}:${option.number}`;
}

function buildGitHubIssuePrompt(issue: GitHubReferenceOption): string {
  return `Fetch and read this GitHub issue, then implement the requested fix or feature.\n\nSource: ${issue.url}\n\nUse the issue details, reproduction notes, linked discussion, and acceptance criteria to produce a complete implementation with tests and documentation updates as needed.`;
}

function buildGitHubPullPrompt(pull: GitHubReferenceOption): string {
  return `Fetch and read this GitHub pull request, inspect the conversation, review comments, check failures, and changed files as needed, then resolve or address all actionable PR review comments.\n\nPR: ${pull.url}\n\nKeep the PR intent intact while making the requested fixes, and verify the result with targeted tests.`;
}

function defaultGitHubRemote(remotes: GitRemote[]): GitRemote | undefined {
  if (remotes.length === 1) return remotes[0];
  return remotes.find((remote) => remote.name === "origin");
}

function gitHubReferenceLabel(option: GitHubReferenceOption): string {
  return `${option.type === "issue" ? "Issue" : "PR"} #${option.number} — ${option.title}`;
}

interface NewTaskGitHubReferencePickerProps {
  isOpen: boolean;
  projectId?: string;
  disabled?: boolean;
  onSelectReference: (option: GitHubReferenceOption) => Promise<boolean> | boolean;
}

/*
FNXC:NewTaskGitHubReference 2026-06-24-00:00:
The New Task dialog gets exactly one compact GitHub reference picker that seeds prompts from the current GitHub remote. It reuses existing remote/list helpers and never imports, closes, comments on, or otherwise mutates GitHub issues/PRs; selecting an item only writes task description text for the executor to fetch/read the selected URL.
*/
function NewTaskGitHubReferencePicker({ isOpen, projectId, disabled = false, onSelectReference }: NewTaskGitHubReferencePickerProps) {
  const { t } = useTranslation("app");
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [loadingRemotes, setLoadingRemotes] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [selectedRemoteName, setSelectedRemoteName] = useState("");
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [pulls, setPulls] = useState<GitHubPull[]>([]);
  const [loadingReferences, setLoadingReferences] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [selectedValue, setSelectedValue] = useState("");
  const remoteRequestIdRef = useRef(0);
  const referenceRequestIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) {
      remoteRequestIdRef.current += 1;
      referenceRequestIdRef.current += 1;
      setRemotes([]);
      setLoadingRemotes(false);
      setRemoteError(null);
      setSelectedRemoteName("");
      setIssues([]);
      setPulls([]);
      setLoadingReferences(false);
      setReferenceError(null);
      setSelectedValue("");
      return;
    }

    const requestId = remoteRequestIdRef.current + 1;
    remoteRequestIdRef.current = requestId;
    setRemotes([]);
    setLoadingRemotes(true);
    setRemoteError(null);
    setSelectedRemoteName("");
    setIssues([]);
    setPulls([]);
    setReferenceError(null);
    setSelectedValue("");

    let cancelled = false;
    fetchGitRemotes(projectId)
      .then((fetchedRemotes) => {
        if (cancelled || remoteRequestIdRef.current !== requestId) return;
        setRemotes(fetchedRemotes);
        const defaultRemote = defaultGitHubRemote(fetchedRemotes);
        setSelectedRemoteName(defaultRemote?.name ?? "");
      })
      .catch((error) => {
        if (cancelled || remoteRequestIdRef.current !== requestId) return;
        setRemoteError(getErrorMessage(error) || t("newTaskModal.githubRemoteError", "Unable to load GitHub remotes."));
      })
      .finally(() => {
        if (!cancelled && remoteRequestIdRef.current === requestId) {
          setLoadingRemotes(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, projectId, t]);

  const selectedRemote = remotes.find((remote) => remote.name === selectedRemoteName);

  useEffect(() => {
    if (!isOpen || !selectedRemote) {
      referenceRequestIdRef.current += 1;
      setIssues([]);
      setPulls([]);
      setLoadingReferences(false);
      setReferenceError(null);
      setSelectedValue("");
      return;
    }

    const requestId = referenceRequestIdRef.current + 1;
    referenceRequestIdRef.current = requestId;
    setIssues([]);
    setPulls([]);
    setLoadingReferences(true);
    setReferenceError(null);
    setSelectedValue("");

    let cancelled = false;
    Promise.all([
      apiFetchGitHubIssues(selectedRemote.owner, selectedRemote.repo, NEW_TASK_GITHUB_REFERENCE_LIMIT),
      apiFetchGitHubPulls(selectedRemote.owner, selectedRemote.repo, NEW_TASK_GITHUB_REFERENCE_LIMIT),
    ])
      .then(([fetchedIssues, fetchedPulls]) => {
        if (cancelled || referenceRequestIdRef.current !== requestId) return;
        setIssues(fetchedIssues);
        setPulls(fetchedPulls);
      })
      .catch((error) => {
        if (cancelled || referenceRequestIdRef.current !== requestId) return;
        setReferenceError(getErrorMessage(error) || t("newTaskModal.githubReferenceError", "Unable to load GitHub issues and pull requests."));
      })
      .finally(() => {
        if (!cancelled && referenceRequestIdRef.current === requestId) {
          setLoadingReferences(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedRemote, t]);

  const issueOptions: GitHubReferenceOption[] = issues.map((issue) => ({ type: "issue", number: issue.number, title: issue.title, url: issue.html_url }));
  const pullOptions: GitHubReferenceOption[] = pulls.map((pull) => ({ type: "pull", number: pull.number, title: pull.title, url: pull.html_url }));
  const allOptions = [...issueOptions, ...pullOptions];
  const multipleRemotesRequireChoice = remotes.length > 1 && !defaultGitHubRemote(remotes) && !selectedRemote;
  const canSelectReference = allOptions.length > 0 && !referenceError;

  const handleReferenceChange = async (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value;
    const option = allOptions.find((candidate) => buildGitHubReferenceValue(candidate) === nextValue);
    if (!option) {
      setSelectedValue("");
      return;
    }
    const accepted = await onSelectReference(option);
    if (accepted) {
      setSelectedValue(nextValue);
    }
  };

  let statusText = "";
  if (loadingRemotes) {
    statusText = t("newTaskModal.githubLoadingRemotes", "Loading GitHub remotes…");
  } else if (remoteError) {
    statusText = remoteError;
  } else if (remotes.length === 0) {
    statusText = t("newTaskModal.githubNoRemotes", "No GitHub remotes were detected for this project.");
  } else if (multipleRemotesRequireChoice) {
    statusText = t("newTaskModal.githubChooseRemote", "Choose a GitHub remote before selecting an issue or pull request.");
  } else if (loadingReferences) {
    statusText = t("newTaskModal.githubLoadingReferences", "Loading open issues and pull requests…");
  } else if (referenceError) {
    statusText = referenceError;
  } else if (selectedRemote && allOptions.length === 0) {
    statusText = t("newTaskModal.githubNoReferences", "No open issues or pull requests were found for the selected remote.");
  } else if (selectedRemote) {
    statusText = t("newTaskModal.githubReferenceHelp", "Select an open issue or pull request to seed the task prompt.");
  }

  return (
    <div className="new-task-github-reference-picker" data-testid="new-task-github-reference-picker">
      <div className="new-task-github-reference-picker__header">
        {canSelectReference ? (
          <label htmlFor="new-task-github-reference-select">{t("newTaskModal.githubReferenceLabel", "GitHub issue or PR")}</label>
        ) : (
          <span className="new-task-github-reference-picker__label">{t("newTaskModal.githubReferenceLabel", "GitHub issue or PR")}</span>
        )}
        {remotes.length === 1 && (
          <span className="new-task-github-reference-picker__remote" data-testid="new-task-github-reference-remote">
            {remotes[0].name}: {remotes[0].owner}/{remotes[0].repo}
          </span>
        )}
      </div>

      {remotes.length > 1 && (
        <select
          className="input new-task-github-reference-picker__remote-select"
          aria-label={t("newTaskModal.githubRemoteLabel", "GitHub remote")}
          data-testid="new-task-github-remote-select"
          value={selectedRemoteName}
          onChange={(event) => setSelectedRemoteName(event.target.value)}
          disabled={disabled || loadingRemotes}
        >
          <option value="">{t("newTaskModal.githubSelectRemote", "Select remote…")}</option>
          {remotes.map((remote) => (
            <option key={remote.name} value={remote.name}>{remote.name}: {remote.owner}/{remote.repo}</option>
          ))}
        </select>
      )}

      {canSelectReference ? (
        <select
          id="new-task-github-reference-select"
          className="input new-task-github-reference-picker__select"
          data-testid="new-task-github-reference-select"
          value={selectedValue}
          onChange={handleReferenceChange}
          disabled={disabled || loadingReferences}
          aria-describedby="new-task-github-reference-status"
        >
          <option value="">{t("newTaskModal.githubSelectReference", "Select issue or PR…")}</option>
          {issueOptions.length > 0 && (
            <optgroup label={t("newTaskModal.githubIssueGroup", "Issues")}>
              {issueOptions.map((option) => (
                <option key={buildGitHubReferenceValue(option)} value={buildGitHubReferenceValue(option)}>{gitHubReferenceLabel(option)}</option>
              ))}
            </optgroup>
          )}
          {pullOptions.length > 0 && (
            <optgroup label={t("newTaskModal.githubPullGroup", "Pull requests")}>
              {pullOptions.map((option) => (
                <option key={buildGitHubReferenceValue(option)} value={buildGitHubReferenceValue(option)}>{gitHubReferenceLabel(option)}</option>
              ))}
            </optgroup>
          )}
        </select>
      ) : null}

      {statusText && (
        <p id="new-task-github-reference-status" className="new-task-github-reference-picker__status" role="status" aria-live="polite" data-testid="new-task-github-reference-status">
          {statusText}
        </p>
      )}
    </div>
  );
}

export function NewTaskModal({ isOpen, onClose, projectId, tasks, onCreateTask, addToast, initialDescription = "", onPlanningMode, onSubtaskBreakdown }: NewTaskModalProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  const viewportMode = useViewportMode();
  useMobileScrollLock(isOpen);
  const { keyboardOverlap, viewportHeight, viewportOffsetTop, keyboardOpen } = useMobileKeyboard({
    enabled: viewportMode === "mobile",
  });
  const keyboardStyle: React.CSSProperties = keyboardOpen
    ? ({
        "--keyboard-overlap": `${keyboardOverlap}px`,
        "--vv-offset-top": `${viewportOffsetTop}px`,
        ...(viewportHeight !== null ? { "--vv-height": `${viewportHeight}px` } : {}),
      } as React.CSSProperties)
    : {};
  const [description, setDescription] = useState("");
  const githubGeneratedDescriptionRef = useRef("");
  const wasOpenRef = useRef(false);

  /*
  FNXC:NewTask 2026-06-22-20:30:
  Floating window position/size state (desktop only). Mobile keeps the full-screen sheet, so we only apply the floating panel style and drag/resize handlers when not mobile. A single active-drag teardown (drag OR resize) lives in dragTeardownRef; pointerup/pointercancel AND the unmount effect run it so an interrupted drag never leaks element pointer listeners or a pending rAF.
  */
  const isFloating = viewportMode !== "mobile";
  const [size, setSizeState] = useState<FloatSize>(() => readFloatSize());
  const [position, setPositionState] = useState<FloatPosition>(() => readFloatPosition(readFloatSize()));
  const dragTeardownRef = useRef<(() => void) | null>(null);
  // FNXC:FloatingWindow 2026-06-22-21:30: Floating (desktop) New Task dialog shares the SINGLE cross-type floating z-index stack (floatingWindowStack). Mounting claims the front; tapping the panel (pointerdown/focus capture) raises it above every other floating modal regardless of type. Mobile keeps the full-screen sheet so this z-index is harmless there.
  const [zIndex, setZIndex] = useState<number>(() => nextFloatingZ());
  const bringToFront = useCallback(() => {
    setZIndex((current) => (current >= currentFloatingZ() ? current : nextFloatingZ()));
  }, []);

  const persistSize = useCallback((next: FloatSize) => {
    setSizeState(writeFloatSize(next));
  }, []);

  const persistPosition = useCallback((next: FloatPosition, withSize: FloatSize) => {
    setPositionState(writeFloatPosition(next, withSize));
  }, []);

  // FNXC:NewTask 2026-06-22-20:30: Header drag. setPointerCapture redirects the pointer stream to the captured header element, so element-scoped pointermove/up listeners receive the full drag even off the header; moves are rAF-batched; the panel is clamped on-screen. Close button clicks are excluded so dragging never swallows close.
  const handleFloatingDragPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = position;
    const currentSize = size;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latest = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = { x: startPosition.x + moveEvent.clientX - startX, y: startPosition.y + moveEvent.clientY - startY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setPositionState(clampFloatPosition(latest, currentSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistPosition(latest, currentSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [persistPosition, position, size]);

  // FNXC:NewTask 2026-06-22-20:30: Corner/edge resize, rAF-batched. West/north handles also shift the panel origin so the opposite edge stays pinned. Same teardown discipline as the drag.
  const handleFloatingResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, direction: FloatResizeDirection) => {
    event.preventDefault();
    event.stopPropagation();
    const captureTarget = event.currentTarget;
    const pointerId = event.pointerId;
    captureTarget.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startSize = size;
    const startPosition = position;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    let latestSize = startSize;
    let latestPosition = startPosition;
    let frame = 0;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const nextSize = clampFloatSize({
        width: startSize.width + (direction.includes("e") ? dx : direction.includes("w") ? -dx : 0),
        height: startSize.height + (direction.includes("s") ? dy : direction.includes("n") ? -dy : 0),
      });
      const nextPosition = {
        x: startPosition.x + (direction.includes("w") ? startSize.width - nextSize.width : 0),
        y: startPosition.y + (direction.includes("n") ? startSize.height - nextSize.height : 0),
      };
      latestSize = nextSize;
      latestPosition = nextPosition;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setSizeState(latestSize);
        setPositionState(clampFloatPosition(latestPosition, latestSize));
      });
    };
    const detachListeners = () => {
      captureTarget.releasePointerCapture?.(pointerId);
      captureTarget.removeEventListener("pointermove", handlePointerMove);
      captureTarget.removeEventListener("pointerup", handlePointerUp);
      captureTarget.removeEventListener("pointercancel", handlePointerUp);
    };
    function handlePointerUp() {
      if (frame) cancelAnimationFrame(frame);
      persistSize(latestSize);
      persistPosition(latestPosition, latestSize);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    }

    dragTeardownRef.current = () => {
      if (frame) cancelAnimationFrame(frame);
      document.body.style.userSelect = previousUserSelect;
      detachListeners();
      dragTeardownRef.current = null;
    };

    captureTarget.addEventListener("pointermove", handlePointerMove);
    captureTarget.addEventListener("pointerup", handlePointerUp);
    captureTarget.addEventListener("pointercancel", handlePointerUp);
  }, [persistPosition, persistSize, position, size]);

  // FNXC:NewTask 2026-06-22-20:30: Run any active drag/resize teardown on unmount so element pointer listeners + a pending rAF never outlive the modal.
  useEffect(() => () => dragTeardownRef.current?.(), []);

  const [dependencies, setDependencies] = useState<string[]>([]);
  const [branchMode, setBranchMode] = useState<BranchSelectionMode>("project-default");
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[] | null>(null);
  const [executorModel, setExecutorModel] = useState("");
  const [validatorModel, setValidatorModel] = useState("");
  const [planningModel, setPlanningModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState<string>("");
  // FNXC:PlannerOversight 2026-07-04-00:00: Per-task override of the workflow-native plannerOversightLevel setting (FN-7508). "" means inherit from workflow.
  const [plannerOversightLevel, setPlannerOversightLevel] = useState<string>("");
  const [selectedPresetId, setSelectedPresetId] = useState<string>("");
  const [presetMode, setPresetMode] = useState<"default" | "preset" | "custom">("default");
  const [hasDirtyState, setHasDirtyState] = useState(false);
  // U6/R3: tri-state workflow selection. `undefined` = inherit project default,
  // `null` = explicit "No workflow", `string` = a specific workflow. Materialized
  // atomically at create time via the `workflowId` create parameter.
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null | undefined>(undefined);
  // Optional workflow steps the user opted into; TaskForm fetches + seeds these
  // from the selected workflow's defaultOn and lifts the enabled set up here.
  const [enabledWorkflowSteps, setEnabledWorkflowSteps] = useState<string[]>([]);
  const [shouldSubmitEnabledWorkflowSteps, setShouldSubmitEnabledWorkflowSteps] = useState(false);
  const [reviewLevel, setReviewLevel] = useState<number | undefined>(undefined);
  const [autoMerge, setAutoMerge] = useState<boolean | undefined>(undefined);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_TASK_PRIORITY);
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  /**
   * FNXC:NewTaskDialogAffordances 2026-06-21-18:35:
   * The New Task dialog must expose the same Fast/standard execution-mode affordance as QuickEntryBox's `quick-entry-fast-toggle`. Reuse TaskForm's `task-form-execution-mode-select` and forward only Fast into `TaskCreateInput.executionMode` so Standard keeps the store default.
   *
   * FNXC:NewTaskDialogAffordances 2026-06-22-02:14:
   * Full-dialog task creation must run the same duplicate preflight as QuickEntryBox before creating. Keep acknowledged duplicate IDs in the create payload so the API receives an explicit user confirmation when the user chooses Create anyway.
   */
  const [executionMode, setExecutionMode] = useState<"standard" | "fast">("standard");
  const [githubTrackingEnabled, setGithubTrackingEnabled] = useState(false);
  /*
  FNXC:FastOptionalSteps 2026-06-30-09:10:
  New task create payloads must distinguish omitted optional-step intent (no controls/no workflow; allow store defaults) from explicit `[]` (operator chose Fast or deselected all; do not re-seed default-on groups) and non-empty manual selections.

  FNXC:FastOptionalSteps 2026-06-30-10:42:
  Fast is itself explicit optional-step intent. Submit the current enabledWorkflowSteps array even before optional-step metadata finishes loading so default-on workflow gates cannot revive through an omitted field.
  */
  const handleEnabledWorkflowStepsChange = useCallback((ids: string[], meta?: EnabledWorkflowStepsChangeMeta) => {
    setEnabledWorkflowSteps(ids);
    setShouldSubmitEnabledWorkflowSteps(meta?.optionalStepsAvailable === true);
  }, []);
  const [githubRepoOverride, setGithubRepoOverride] = useState("");

  // Agent assignment state
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const { agents, loading: agentsLoading } = useAgentsMapCache(projectId);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const agentPickerRef = useRef<HTMLDivElement>(null);

  // Quick-fields dependency picker state
  const [showDeps, setShowDeps] = useState(false);
  const [depSearch, setDepSearch] = useState("");
  const quickFieldsDepRef = useRef<HTMLDivElement>(null);

  const { hasAiProvider, hasGithub, loading: setupReadinessLoading } = useSetupReadiness(projectId);
  /*
  FNXC:SetupWarning 2026-07-03-00:00:
  The New Task modal does not own the Settings navigation callback that can open Authentication, so it must not show the delayed GitHub warning without the required Connect GitHub CTA. Keep immediate AI-provider warnings here and let the dashboard banner render the actionable GitHub warning.
  */
  const visibleSetupHasWarnings = !hasAiProvider;
  const { nodes } = useNodes();

  /**
   * FNXC:SelectionComment 2026-06-16-23:58:
   * Selection comments open the normal New Task dialog with a prefilled description; seed only on the closed→open transition so rerenders do not overwrite user edits.
   */
  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setDescription(initialDescription);
    }
    wasOpenRef.current = isOpen;
  }, [initialDescription, isOpen]);

  // Load agents for agent picker
  const loadAgents = useCallback(() => {
    setShowAgentPicker(true);
  }, []);

  // Close agent picker when clicking outside
  useEffect(() => {
    if (!showAgentPicker) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showAgentPicker]);

  // Close quick-fields dep dropdown when clicking outside
  useEffect(() => {
    if (!showDeps) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (quickFieldsDepRef.current && !quickFieldsDepRef.current.contains(e.target as Node)) {
        setShowDeps(false);
        setDepSearch("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showDeps]);

  // Compute available deps for quick-fields picker (same logic as TaskForm)
  const availableDeps = tasks
    .filter((t) => !dependencies.includes(t.id))
    .sort((a, b) => {
      const cmp = b.createdAt.localeCompare(a.createdAt);
      if (cmp !== 0) return cmp;
      const aNum = parseInt(a.id.slice(a.id.lastIndexOf("-") + 1), 10) || 0;
      const bNum = parseInt(b.id.slice(b.id.lastIndexOf("-") + 1), 10) || 0;
      return bNum - aNum;
    });

  const filteredDeps = depSearch
    ? availableDeps.filter((t) =>
        t.id.toLowerCase().includes(depSearch.toLowerCase()) ||
        (t.title && t.title.toLowerCase().includes(depSearch.toLowerCase())) ||
        (t.description && t.description.toLowerCase().includes(depSearch.toLowerCase()))
      )
    : availableDeps;

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  const githubRepoOverrideTrimmed = githubRepoOverride.trim();
  const githubRepoOverrideInvalid = githubRepoOverrideTrimmed.length > 0 && !REPO_OVERRIDE_RE.test(githubRepoOverrideTrimmed);
  const isBranchNameRequired = branchMode === "existing" || branchMode === "custom-new" || branchMode === "shared-group";
  const hasInvalidBranchSelection = isBranchNameRequired && !branch.trim();

  // Track dirty state
  useEffect(() => {
    const isDirty =
      description.trim() !== "" ||
      dependencies.length > 0 ||
      pendingImages.length > 0 ||
      selectedWorkflowId !== undefined ||
      // Optional workflow steps the user toggled count as unsaved work. (Workflows
      // whose steps are defaultOn:false — today's only shipped step — seed an empty
      // set, so this stays false until the user actually opts a step in.)
      shouldSubmitEnabledWorkflowSteps ||
      enabledWorkflowSteps.length > 0 ||
      executorModel !== "" ||
      validatorModel !== "" ||
      planningModel !== "" ||
      thinkingLevel !== "" ||
      plannerOversightLevel !== "" ||
      selectedAgentId !== null ||
      reviewLevel !== undefined ||
      autoMerge !== undefined ||
      priority !== DEFAULT_TASK_PRIORITY ||
      nodeId !== undefined ||
      executionMode === "fast" ||
      branchMode !== "project-default" ||
      branch !== "" ||
      baseBranch !== "" ||
      githubTrackingEnabled ||
      githubRepoOverrideTrimmed !== "";
    setHasDirtyState(isDirty);
  }, [description, dependencies, pendingImages, selectedWorkflowId, shouldSubmitEnabledWorkflowSteps, enabledWorkflowSteps, executorModel, validatorModel, planningModel, thinkingLevel, plannerOversightLevel, selectedAgentId, reviewLevel, autoMerge, priority, nodeId, executionMode, branchMode, branch, baseBranch, githubTrackingEnabled, githubRepoOverrideTrimmed]);

  const resetForm = useCallback(() => {
    // Clean up object URLs
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    // Reset form
    setPendingImages([]);
    setDescription("");
    setDependencies([]);
    setExecutorModel("");
    setValidatorModel("");
    setPlanningModel("");
    setThinkingLevel("");
    setPlannerOversightLevel("");
    setSelectedPresetId("");
    setPresetMode("default");
    setSelectedWorkflowId(undefined);
    setEnabledWorkflowSteps([]);
    setShouldSubmitEnabledWorkflowSteps(false);
    setSelectedAgentId(null);
    setShowAgentPicker(false);
    setReviewLevel(undefined);
    setAutoMerge(undefined);
    setPriority(DEFAULT_TASK_PRIORITY);
    setNodeId(undefined);
    setExecutionMode("standard");
    setBranchMode("project-default");
    setBranch("");
    setBaseBranch("");
    setHasDirtyState(false);
    setGithubTrackingEnabled(false);
    setGithubRepoOverride("");
    setDuplicateMatches(null);
    githubGeneratedDescriptionRef.current = "";
  }, [pendingImages]);

  const handleClose = useCallback(async () => {
    if (hasDirtyState) {
      const shouldDiscard = await confirm({
        title: t("newTaskModal.discardChanges", "Discard Changes"),
        message: t("newTaskModal.unsavedChanges", "You have unsaved changes. Discard them?"),
        danger: true,
      });
      if (!shouldDiscard) return;
    }
    resetForm();
    onClose();
  }, [hasDirtyState, onClose, confirm, t, resetForm]);

  /**
   * FNXC:NewTaskDialogAffordances 2026-06-21-17:50:
   * The New Task dialog must expose the same Plan and Subtask quick-add handoff affordances as QuickEntryBox. Close without the dirty-state discard confirmation because the typed description is intentionally handed off to the planning/subtask modal instead of discarded.
   */
  const handleAiAssistClose = useCallback(() => {
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const performCreate = useCallback(async (trimmedDesc: string, acknowledgedDuplicates?: string[]) => {
    const executorSlashIdx = executorModel.indexOf("/");
    const validatorSlashIdx = validatorModel.indexOf("/");
    const planningSlashIdx = planningModel.indexOf("/");

    /*
    FNXC:CodingIdeasWorkflow 2026-07-05-00:00:
    Do not hard-code `column: "triage"` — the store resolves the landing column from the (materialized) workflowId below, so a manual-intake workflow (e.g. Coding (Ideas) → "ideas") parks the card for the operator instead of being auto-triaged.
    */
    const createInput: NewTaskCreateInput = {
      title: undefined,
      description: trimmedDesc,
      dependencies: dependencies.length ? dependencies : undefined,
      // U6/R3: forward the workflow selection only when the user changed it.
      //  - undefined → omit (store inherits the project default, today's behavior)
      //  - null      → explicit "No workflow" (store skips default materialization)
      //  - string    → that workflow, materialized atomically at create time.
      ...(selectedWorkflowId !== undefined ? { workflowId: selectedWorkflowId } : {}),
      // Optional steps are omitted only when no controls were available. Fast always submits explicit []/ids so async metadata races cannot fall back to store defaultOn gates.
      ...(shouldSubmitEnabledWorkflowSteps || executionMode === "fast" ? { enabledWorkflowSteps } : {}),
      ...(selectedAgentId ? { assignedAgentId: selectedAgentId } : {}),
      modelPresetId: presetMode === "preset" ? selectedPresetId || undefined : undefined,
      modelProvider: executorModel && executorSlashIdx !== -1 ? executorModel.slice(0, executorSlashIdx) : undefined,
      modelId: executorModel && executorSlashIdx !== -1 ? executorModel.slice(executorSlashIdx + 1) : undefined,
      validatorModelProvider: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(0, validatorSlashIdx) : undefined,
      validatorModelId: validatorModel && validatorSlashIdx !== -1 ? validatorModel.slice(validatorSlashIdx + 1) : undefined,
      planningModelProvider: planningModel && planningSlashIdx !== -1 ? planningModel.slice(0, planningSlashIdx) : undefined,
      planningModelId: planningModel && planningSlashIdx !== -1 ? planningModel.slice(planningSlashIdx + 1) : undefined,
      thinkingLevel: thinkingLevel !== "" ? thinkingLevel as "minimal" | "low" | "medium" | "high" | "xhigh" : undefined,
      // FNXC:PlannerOversight 2026-07-04-00:00: omit when "Inherit from workflow" ("") is selected so the task falls back to the workflow's effective plannerOversightLevel.
      ...(plannerOversightLevel !== "" ? { plannerOversightLevel: plannerOversightLevel as "off" | "observe" | "steer" | "autonomous" } : {}),
      reviewLevel,
      ...(autoMerge !== undefined ? { autoMerge } : {}),
      priority,
      nodeId,
      ...(executionMode === "fast" ? { executionMode: "fast" } : {}),
      branchSelection: {
        mode: branchMode,
        ...(isBranchNameRequired && branch.trim() ? { branchName: branch.trim() } : {}),
        ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      },
      ...(acknowledgedDuplicates?.length ? { acknowledgedDuplicates } : {}),
      ...(githubTrackingEnabled || githubRepoOverrideTrimmed !== ""
        ? {
            githubTracking: {
              enabled: githubTrackingEnabled,
              ...(githubRepoOverrideTrimmed !== "" ? { repoOverride: githubRepoOverrideTrimmed } : {}),
            },
          }
        : {}),
    };

    // U6/R3: the workflow is now materialized atomically inside createTask via
    // the `workflowId` parameter — no post-create selectTaskWorkflow call, so
    // the executor can never observe the task with the wrong step set.
    const task = await onCreateTask(createInput);

    // Upload pending images as attachments
    if (pendingImages.length > 0) {
      const failures: string[] = [];
      for (const img of pendingImages) {
        try {
          await uploadAttachment(task.id, img.file, projectId);
        } catch {
          failures.push(img.file.name);
        }
      }
      if (failures.length > 0) {
        addToast(t("newTaskModal.failedToUpload", "Failed to upload: {{files}}", { files: failures.join(", ") }), "error");
      }
    }

    resetForm();
    addToast(t("newTaskModal.taskCreated", "Created {{taskId}}", { taskId: task.id }), "success");
    onClose();
  }, [executorModel, validatorModel, planningModel, thinkingLevel, plannerOversightLevel, dependencies, selectedWorkflowId, shouldSubmitEnabledWorkflowSteps, enabledWorkflowSteps, selectedAgentId, presetMode, selectedPresetId, reviewLevel, autoMerge, priority, nodeId, executionMode, branchMode, isBranchNameRequired, branch, baseBranch, githubTrackingEnabled, githubRepoOverrideTrimmed, onCreateTask, pendingImages, resetForm, addToast, t, onClose, projectId]);

  const handleSubmit = useCallback(async () => {
    const trimmedDesc = description.trim();
    if (!trimmedDesc || isSubmitting || githubRepoOverrideInvalid || hasInvalidBranchSelection) return;

    setIsSubmitting(true);
    let keepSubmittingForDuplicateChoice = false;
    try {
      const matches = await checkDuplicateTasks({ description: trimmedDesc }, projectId);
      if (matches.length > 0) {
        setDuplicateMatches(matches);
        keepSubmittingForDuplicateChoice = true;
        return;
      }
    } catch (_error) {
      addToast(t("tasks.duplicateCheckFailed", "Duplicate check failed; creating task anyway."), "error");
    }

    try {
      await performCreate(trimmedDesc);
    } catch (err) {
      addToast(getErrorMessage(err) || t("newTaskModal.failedToCreate", "Failed to create task"), "error");
    } finally {
      if (!keepSubmittingForDuplicateChoice) {
        setIsSubmitting(false);
      }
    }
  }, [description, isSubmitting, githubRepoOverrideInvalid, hasInvalidBranchSelection, projectId, addToast, t, performCreate]);

  const handleDuplicateOpen = useCallback((taskId: string) => {
    setDuplicateMatches(null);
    if (typeof window !== "undefined") {
      window.location.hash = `#/tasks/${taskId}`;
    }
    resetForm();
    onClose();
  }, [onClose, resetForm]);

  const handleDuplicateProceed = useCallback(async () => {
    const trimmedDesc = description.trim();
    const matches = duplicateMatches;
    if (!trimmedDesc || !matches || matches.length === 0) {
      setDuplicateMatches(null);
      setIsSubmitting(false);
      return;
    }

    setDuplicateMatches(null);
    setIsSubmitting(true);
    try {
      await performCreate(trimmedDesc, matches.map((match) => match.id));
    } catch (err) {
      addToast(getErrorMessage(err) || t("newTaskModal.failedToCreate", "Failed to create task"), "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [description, duplicateMatches, performCreate, addToast, t]);

  const handleDuplicateCancel = useCallback(() => {
    setDuplicateMatches(null);
    setIsSubmitting(false);
  }, []);

  const handleGitHubReferenceSelect = useCallback(async (option: GitHubReferenceOption) => {
    const nextDescription = option.type === "issue" ? buildGitHubIssuePrompt(option) : buildGitHubPullPrompt(option);
    const currentDescription = description.trim();
    const currentGenerated = githubGeneratedDescriptionRef.current;
    // FNXC:NewTaskGitHubReference 2026-06-24-00:00: Protect user-authored prompt text from silent replacement; generated GitHub templates may be replaced without another confirm so issue↔PR switching stays lightweight.
    const shouldConfirmOverwrite = currentDescription !== "" && description !== currentGenerated && description !== nextDescription;

    if (shouldConfirmOverwrite) {
      const shouldOverwrite = await confirm({
        title: t("newTaskModal.githubOverwriteTitle", "Replace description?"),
        message: t("newTaskModal.githubOverwriteMessage", "Selecting a GitHub issue or PR will replace the current task description. Continue?"),
      });
      if (!shouldOverwrite) return false;
    }

    githubGeneratedDescriptionRef.current = nextDescription;
    setDescription(nextDescription);
    return true;
  }, [confirm, description, t]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }, [handleClose]);

  // Compute selected agent label for display
  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) : undefined;
  const selectedAgentLabel = selectedAgent?.name ?? selectedAgentId;

  // Quick fields: promoted dependencies and agent assignment
  const quickFields = (
    <div className="new-task-quick-fields">
      <NewTaskGitHubReferencePicker
        isOpen={isOpen}
        projectId={projectId}
        disabled={isSubmitting}
        onSelectReference={handleGitHubReferenceSelect}
      />

      {/* Dependencies field */}
      <div className="form-group">
        <label>{t("newTaskModal.dependencies", "Dependencies")}</label>
        <div className="dep-trigger-wrap" ref={quickFieldsDepRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDeps((v) => !v)}
            disabled={isSubmitting}
            data-testid="dep-trigger"
          >
            {dependencies.length > 0 ? t("newTaskModal.selectedCount", "{{count}} selected", { count: dependencies.length }) : t("newTaskModal.addDependencies", "Add dependencies")}
          </button>
          {showDeps && (
            <div className="dep-dropdown">
              <input
                className="dep-dropdown-search"
                placeholder={t("newTaskModal.searchTasks", "Search tasks…")}
                autoFocus
                value={depSearch}
                onChange={(e) => setDepSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
              {filteredDeps.length === 0 ? (
                <div className="dep-dropdown-empty">{t("newTaskModal.noAvailableTasks", "No available tasks")}</div>
              ) : (
                filteredDeps.map((t) => (
                  <div
                    key={t.id}
                    className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                    onClick={() => {
                      setDependencies(
                        dependencies.includes(t.id) ? dependencies.filter((d) => d !== t.id) : [...dependencies, t.id],
                      );
                      setShowDeps(false);
                      setDepSearch("");
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                  >
                    <span className="dep-dropdown-id">{t.id}</span>
                    <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {dependencies.length > 0 && (
          <div className="selected-deps">
            {dependencies.map((depId) => (
              <span key={depId} className="dep-chip">
                {depId}
                <button
                  type="button"
                  className="dep-chip-remove"
                  onClick={() => setDependencies(dependencies.filter((d) => d !== depId))}
                  disabled={isSubmitting}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Agent Assignment */}
      <div className="form-group">
        <label>{t("newTaskModal.assignAgent", "Assign Agent")}</label>
        <div className="agent-trigger-wrap" ref={agentPickerRef}>
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => {
              if (showAgentPicker) {
                setShowAgentPicker(false);
              } else {
                void loadAgents();
              }
            }}
            disabled={isSubmitting}
            data-testid="new-task-agent-button"
          >
            <Bot size={12} style={{ verticalAlign: "middle" }} />
            {selectedAgentLabel ? ` ${selectedAgentLabel}` : ` ${t("newTaskModal.assignAgentButton", "Assign agent")}`}
          </button>
          {showAgentPicker && (
            <div className="dep-dropdown agent-picker-dropdown" onMouseDown={(e) => e.preventDefault()}>
              <div className="dep-dropdown-search-header">{t("newTaskModal.selectAgent", "Select agent")}</div>
              {agentsLoading && <div className="dep-dropdown-empty"><LoadingSpinner label={t("newTaskModal.loadingAgents", "Loading agents...")} /></div>}
              {!agentsLoading && agents.map((a) => (
                <div
                  key={a.id}
                  className={`dep-dropdown-item${selectedAgentId === a.id ? " selected" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelectedAgentId(a.id === selectedAgentId ? null : a.id);
                    setShowAgentPicker(false);
                  }}
                  data-testid={`agent-option-${a.id}`}
                >
                  <Bot size={12} style={{ marginRight: 6 }} />
                  <span className="dep-dropdown-id">{a.role}</span>
                  <span className="dep-dropdown-title">{a.name}</span>
                </div>
              ))}
              {!agentsLoading && agents.length === 0 && (
                <div className="dep-dropdown-empty">{t("newTaskModal.noAgentsAvailable", "No agents available")}</div>
              )}
              {selectedAgentId && (
                <div
                  className="dep-dropdown-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSelectedAgentId(null);
                    setShowAgentPicker(false);
                  }}
                >
                  <span className="dep-dropdown-title">{t("newTaskModal.clearSelection", "Clear selection")}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* U6/R3: the workflow picker now lives inside TaskForm (a whole-workflow
          dropdown materialized atomically at create time), replacing the prior
          standalone WorkflowSelector + post-create selectTaskWorkflow flow. */}
    </div>
  );

  if (!isOpen) return null;

  // FNXC:NewTask 2026-06-22-20:30: Desktop = floating fixed panel positioned by state-driven left/top/width/height. Mobile keeps the keyboard-aware full-screen sheet (no floating). The transparent click-through overlay never dismisses on click; the header X / Cancel / Escape are the only dismissals.
  const panelStyle: CSSProperties = isFloating
    ? { left: `${position.x}px`, top: `${position.y}px`, width: `${size.width}px`, height: `${size.height}px`, zIndex }
    : keyboardStyle;

  // FNXC:FloatingWindow 2026-06-22-22:30: Portaled to document.body so the floating New Task dialog shares the ONE root stacking context with the other floating modals; the shared cross-type z stack only orders correctly at the document root. Mobile sheet is position:fixed, unaffected.
  return createPortal(
    <>
      <div
        className="modal-overlay open new-task-modal-overlay"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-modal="false"
        aria-label={t("newTaskModal.title", "New Task")}
        data-testid="new-task-modal-overlay"
        /* FNXC:FloatingWindow 2026-06-22-23:00: In floating mode the z-index lives on the fixed overlay (it owns the stacking context); a panel z is trapped and loses to page stacking contexts like the right dock. Mobile keeps its CSS z. */
        style={isFloating ? { zIndex } : undefined}
      >
        <div
          className={`modal modal-lg new-task-modal${isFloating ? " new-task-modal--floating" : ""}`}
          style={panelStyle}
          onPointerDownCapture={isFloating ? bringToFront : undefined}
          onFocusCapture={isFloating ? bringToFront : undefined}
        >
          {isFloating && NEW_TASK_RESIZE_DIRECTIONS.map((direction) => (
            <div
              key={direction}
              className={`new-task-resize-handle new-task-resize-handle--${direction}`}
              data-testid={`new-task-resize-${direction}`}
              role="separator"
              aria-label={t("newTaskModal.resize", "Resize new task window")}
              onPointerDown={(event) => handleFloatingResizePointerDown(event, direction)}
            />
          ))}
          <div
            className={`modal-header${isFloating ? " new-task-modal__header--draggable" : ""}`}
            data-testid="new-task-drag-handle"
            onPointerDown={isFloating ? handleFloatingDragPointerDown : undefined}
          >
          <h3>{t("newTaskModal.title", "New Task")}</h3>
          <button className="modal-close" onClick={handleClose} disabled={isSubmitting} aria-label={t("actions.close", "Close")}>
            &times;
          </button>
        </div>

        <div className="modal-body">
          {!setupReadinessLoading && visibleSetupHasWarnings && (
            <SetupWarningBanner
              hasAiProvider={hasAiProvider}
              hasGithub={hasGithub}
              showGithubWarning={false}
            />
          )}

          <TaskForm
            mode="create"
            description={description}
            onDescriptionChange={setDescription}
            dependencies={dependencies}
            onDependenciesChange={setDependencies}
            executorModel={executorModel}
            onExecutorModelChange={setExecutorModel}
            validatorModel={validatorModel}
            onValidatorModelChange={setValidatorModel}
            presetMode={presetMode}
            onPresetModeChange={setPresetMode}
            selectedPresetId={selectedPresetId}
            onSelectedPresetIdChange={setSelectedPresetId}
            selectedWorkflowId={selectedWorkflowId}
            onWorkflowIdChange={setSelectedWorkflowId}
            enabledWorkflowSteps={enabledWorkflowSteps}
            onEnabledWorkflowStepsChange={handleEnabledWorkflowStepsChange}
            pendingImages={pendingImages}
            onImagesChange={setPendingImages}
            tasks={tasks}
            projectId={projectId}
            disabled={isSubmitting}
            addToast={addToast}
            isActive={isOpen}
            onClose={handleAiAssistClose}
            onPlanningMode={onPlanningMode}
            onSubtaskBreakdown={onSubtaskBreakdown}
            planningModel={planningModel}
            onPlanningModelChange={setPlanningModel}
            thinkingLevel={thinkingLevel}
            plannerOversightLevel={plannerOversightLevel}
            onPlannerOversightLevelChange={setPlannerOversightLevel}
            onThinkingLevelChange={setThinkingLevel}
            reviewLevel={reviewLevel}
            onReviewLevelChange={setReviewLevel}
            autoMerge={autoMerge}
            onAutoMergeChange={setAutoMerge}
            priority={priority}
            onPriorityChange={setPriority}
            branch={branch}
            onBranchChange={setBranch}
            branchMode={branchMode}
            onBranchModeChange={setBranchMode}
            baseBranch={baseBranch}
            onBaseBranchChange={setBaseBranch}
            nodeId={nodeId}
            onNodeIdChange={setNodeId}
            nodeOptions={nodes}
            executionMode={executionMode}
            onExecutionModeChange={setExecutionMode}
            githubTrackingEnabled={githubTrackingEnabled}
            onGithubTrackingEnabledChange={setGithubTrackingEnabled}
            githubRepoOverride={githubRepoOverride}
            onGithubRepoOverrideChange={setGithubRepoOverride}
            onCreateSubmit={handleSubmit}
            createSubmitLabel={isSubmitting ? t("newTaskModal.creating", "Creating...") : t("newTaskModal.createTask", "Create Task")}
            createSubmitDisabled={!description.trim() || isSubmitting || githubRepoOverrideInvalid || hasInvalidBranchSelection}
            renderBelowPrimary={quickFields}
            hideDependencies={true}
            autoExpandMoreOptionsOnSelection={false}
          />

        </div>

        {hasInvalidBranchSelection && (
          <div className="form-error new-task-branch-error">{t("newTaskModal.branchRequired", "Branch name is required for this branch strategy.")}</div>
        )}

          <div className="modal-actions">
            <button className="btn btn-sm" onClick={handleClose} disabled={isSubmitting}>
              {t("actions.cancel", "Cancel")}
            </button>
          </div>
        </div>
      </div>
      {duplicateMatches && (
        <DuplicateWarningModal
          matches={duplicateMatches}
          onOpen={handleDuplicateOpen}
          onProceed={handleDuplicateProceed}
          onCancel={handleDuplicateCancel}
        />
      )}
    </>,
    document.body,
  );
}
