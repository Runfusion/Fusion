import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReportActionType, ReportTarget } from "@fusion/core";
import { reportAttachment, reportDraft, reportFile, reportHelp } from "../api";
import { captureScreenshot as captureScreen, getRecentActivity, recordActivity } from "../utils/report-capture";
import "./ReportModal.css";

const prompts: Record<ReportActionType, string> = { bug: "What went wrong?", feedback: "What would you like to share?", idea: "What would you like Fusion to do?", help: "What would you like help with?" };

type ModalResult = { kind: string; destination?: "issue" | "discussion"; report?: { userPrompt: string; sourcePrompt?: string; summary?: string; body?: string; context?: Record<string, unknown>; sessionToken?: string }; issue?: { number: number; url: string; title: string; discussionId?: string; roadmap?: true }; url?: string; answer?: { summary?: string; content?: string }; message?: string; screenshotNotAttached?: boolean };


/**
 * FNXC:ReportPipeline 2026-07-16-12:00:
 * The four actions start with a guided user prompt, not a raw issue form. The
 * final filed or endorsed link remains visible after the selected mode acts.
 */
export function ReportModal({ actionType, onClose, contextRefs }: { actionType: ReportActionType; onClose: () => void; contextRefs?: { taskId?: string; agentId?: string } }) {
  const { t } = useTranslation("app");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<ModalResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [screenshotEnabled, setScreenshotEnabled] = useState(false);
  // FNXC:ReportPipeline 2026-07-16-21:00: A reporter can override the inherited target for this filing only.
  const [targetType, setTargetType] = useState<ReportTarget | undefined>();
  const [screenshotArtifactId, setScreenshotArtifactId] = useState<string>();
  const [retentionConfirmed, setRetentionConfirmed] = useState(false);
  const captureGeneration = useRef(0);
  const captureScreenshot = async (generation: number) => {
    setBusy(true);
    setError(undefined);
    try {
      const captured = await captureScreen();
      if (!captured) throw new Error("Screen capture was unavailable or denied.");
      const { artifactId } = await reportAttachment(captured);
      if (captureGeneration.current !== generation) return;
      setScreenshotArtifactId(artifactId);
    } catch (captureError) {
      if (captureGeneration.current !== generation) return;
      setScreenshotEnabled(false);
      setError(captureError instanceof Error ? captureError.message : "We could not capture the current screen.");
    } finally {
      if (captureGeneration.current === generation) setBusy(false);
    }
  };
  const submit = async () => {
    if (!prompt.trim()) return;
    if (screenshotEnabled && (!screenshotArtifactId || !retentionConfirmed)) {
      setError("Capture and confirm local screenshot retention before continuing, or turn attachment off.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      recordActivity("report");
      if (actionType === "help") {
        const help = await reportHelp(prompt);
        if (help.answered) { setResult({ kind: "help", answer: help.answer }); return; }
      }
      setResult(await reportDraft({ actionType, targetType, userPrompt: prompt, contextRefs, activityTrace: getRecentActivity(), screenshotArtifactId: screenshotEnabled && retentionConfirmed ? screenshotArtifactId : undefined }));
    } catch {
      setError("We could not prepare your report. Check your connection and try again.");
    } finally { setBusy(false); }
  };
  const file = async (endorseIssueNumber?: number, endorseDiscussionId?: string, endorseRoadmapIssueNumber?: number) => {
    if (!result?.report) return;
    setBusy(true);
    setError(undefined);
    try {
      recordActivity("report");
setResult(await reportFile({ actionType, targetType, report: result.report, endorseIssueNumber, endorseDiscussionId, endorseRoadmapIssueNumber, activityTrace: getRecentActivity(), screenshotArtifactId: screenshotEnabled && retentionConfirmed ? screenshotArtifactId : undefined }));

    } catch {
      setError("We could not send your report. Your draft is still here; try again.");
    } finally { setBusy(false); }
  };
  return <div className="report-modal-backdrop" role="presentation"><section className="card report-modal" role="dialog" aria-modal="true" aria-label={`${actionType} report`}>
    <button className="btn-icon report-modal__close" type="button" aria-label="Close report" onClick={onClose}>×</button>
    {error && <p className="report-modal__error" role="alert">{error}</p>}
    {!result && <><h2>{actionType[0].toUpperCase() + actionType.slice(1)}</h2><label htmlFor="report-prompt">{prompts[actionType]}</label><textarea id="report-prompt" className="input" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} />
      {/* FNXC:ReportPipeline 2026-07-19-10:00: Screenshot storage is opt-in and
      requires retention confirmation before its artifact reference is sent. A
      capture that finishes after opt-out is discarded rather than restoring it. */}
      <label className="report-modal__screenshot-option"><input type="checkbox" checked={screenshotEnabled} onChange={(event) => { const enabled = event.target.checked; const generation = ++captureGeneration.current; setScreenshotEnabled(enabled); setScreenshotArtifactId(undefined); setRetentionConfirmed(false); if (enabled) void captureScreenshot(generation); else setBusy(false); }} /> Store a screenshot locally</label>
      {screenshotEnabled && <div className="report-modal__screenshot-preview">
        {screenshotArtifactId ? <label className="report-modal__screenshot-option"><input type="checkbox" checked={retentionConfirmed} onChange={(event) => setRetentionConfirmed(event.target.checked)} /> I confirm Fusion may retain this screenshot locally for this report.</label> : <p>Capturing and storing locally…</p>}
      </div>}
      <label htmlFor="report-target">{t("report.targetLabel", "Filing target")}</label><select id="report-target" className="input" value={targetType ?? ""} onChange={(event) => setTargetType((event.target.value || undefined) as ReportTarget | undefined)}><option value="">{t("report.targetInherit", "Use configured action target")}</option><option value="issue">{t("report.targetIssue", "GitHub Issue")}</option><option value="discussion">{t("report.targetDiscussion", "GitHub Discussion")}</option></select>
      <details className="report-modal__activity-trace"><summary>Activity trace to send</summary><ul>{getRecentActivity().map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul></details>
      <button className="btn btn-primary" type="button" disabled={!prompt.trim() || busy} onClick={() => void submit()}>{error ? "Retry" : "Continue"}</button></>}
    {result?.kind === "draft-ready" && result.report && <><h2>Review your report</h2><label htmlFor="report-review-prompt">Report summary</label><textarea id="report-review-prompt" className="input" value={result.report.userPrompt} onChange={(event) => {
      const userPrompt = event.target.value;
      // FNXC:ReportPipeline 2026-07-16-18:45:
      // Keep the original derivation marker when the guided prompt changes.
      // The server then rebuilds every derived section with newly gathered
      // context, rather than discarding the report's reproduction/environment
      // sections while the user is editing a draft.
      setResult({ ...result, report: { ...result.report!, userPrompt } });
    }} /><label htmlFor="report-review-body">Structured report</label><textarea id="report-review-body" className="input" value={result.report.body ?? ""} onChange={(event) => setResult({ ...result, report: { ...result.report!, body: event.target.value } })} /><button className="btn btn-primary" type="button" disabled={busy} onClick={() => void file()}>File report</button></>}
    {result?.kind === "duplicate-found" && result.issue && result.report && <>
      {/*
      FNXC:ReportPipeline 2026-07-16-21:30:
      Draft-review applies to duplicate endorsements too. Show the scrubbed
      structured data point and require an explicit confirmation after edits
      instead of posting a dedupe match immediately.
      */}
      {/* FNXC:ReportPipeline 2026-07-18-20:45: A public-roadmap duplicate is endorsed through the same reviewed data-point UI as an issue, so reporters strengthen the tracked item rather than opening a parallel thread. */}
      <h2>{result.issue.roadmap ? t("report.roadmapDuplicate.title", "Already on the roadmap — add your data point?") : "Review data point for a similar open issue"}</h2>
      <a href={result.issue.url} target="_blank" rel="noreferrer">{result.issue.title}</a>
      <label htmlFor="report-duplicate-prompt">Report summary</label>
      <textarea id="report-duplicate-prompt" className="input" value={result.report.userPrompt} onChange={(event) => {
        const userPrompt = event.target.value;
        setResult({ ...result, report: { ...result.report!, userPrompt } });
      }} />
      <label htmlFor="report-duplicate-body">Structured data point</label>
      <textarea id="report-duplicate-body" className="input" value={result.report.body ?? ""} onChange={(event) => setResult({ ...result, report: { ...result.report!, body: event.target.value } })} />
      <button className="btn btn-primary" type="button" disabled={busy} onClick={() => void file(result.issue!.discussionId ? undefined : result.issue!.roadmap ? undefined : result.issue!.number, result.issue!.discussionId, result.issue!.roadmap ? result.issue!.number : undefined)}>Confirm and add data point</button>
    </>}

{(result?.kind === "filed" || result?.kind === "endorsed") && <>
      {/* FNXC:ReportPipeline 2026-07-18-12:30: When disabled Discussions fall back to
      Issues, state the actual filed destination rather than implying the report became a Discussion. */}
      <h2>{result.kind === "filed" && result.destination === "issue" ? "Report filed as an Issue" : "Report sent"}</h2><a href={result.url} target="_blank" rel="noreferrer">View on GitHub</a>{result.report?.body && <><label htmlFor="filed-report">Final report</label><textarea id="filed-report" className="input" value={result.report.body} readOnly /></>}</>}

    {result?.kind === "help" && <><h2>Suggested help</h2><p>{result.answer?.summary ?? result.answer?.content}</p></>}
    {result?.kind === "unavailable" && <>
      <p role="alert">{result.message}</p>
      <button className="btn btn-secondary" type="button" onClick={() => { setResult(undefined); setError(undefined); }}>Return to prompt</button>
    </>}
  </section></div>;
}
