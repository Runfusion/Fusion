import { memo, useEffect, useState } from "react";
import { BarChart3, Flag, Lightbulb, Map, Target } from "lucide-react";
import type { NativeStructurePreviewResult, NativeStructureRef } from "@fusion/core";
import { fetchNativeStructurePreview } from "../api";
import "./NativeStructurePreview.css";

export interface NativeStructurePreviewProps {
  ref: NativeStructureRef;
  payload?: NativeStructurePreviewResult;
  onOpen: (ref: NativeStructureRef, payload: NativeStructurePreviewResult) => void;
}

const icons = {
  mission: Map,
  milestone: Flag,
  "research-finding": Lightbulb,
  "eval-result": BarChart3,
  goal: Target,
};

function unavailableLabel(kind: NativeStructureRef["kind"]): string {
  return kind.replace(/-/g, " ");
}

/**
 * FNXC:NativeStructureEmbed 2026-07-16-12:00:
 * Chat and mail use this one memoized renderer for compact structure cards. Navigation remains
 * owned by each consumer through `onOpen` because dashboard views use callback/view state rather
 * than URL routes; rendering an anchor here would create dead destinations.
 */
export const NativeStructurePreview = memo(function NativeStructurePreview({ ref, payload, onOpen }: NativeStructurePreviewProps) {
  const refKey = `${ref.kind}\u0000${ref.id}\u0000${ref.projectId ?? ""}`;
  const [fetchedPayload, setFetchedPayload] = useState<{ refKey: string; result: NativeStructurePreviewResult } | undefined>();
  const [error, setError] = useState(false);
  // FNXC:NativeStructureEmbed 2026-07-16-12:00: A ref update must not briefly render a prior fetch result; consumers can replace cards while messages or drafts rehydrate.
  const result = payload ?? (fetchedPayload?.refKey === refKey ? fetchedPayload.result : undefined);
  const Icon = icons[ref.kind];

  useEffect(() => {
    if (payload) return;
    let active = true;
    setFetchedPayload(undefined);
    setError(false);
    void fetchNativeStructurePreview(ref)
      .then((nextPayload) => {
        if (active) setFetchedPayload({ refKey, result: nextPayload });
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => { active = false; };
  }, [payload, ref.kind, ref.id, ref.projectId, refKey]);

  if (error) {
    return (
      <section className="native-structure-preview native-structure-preview--unavailable" data-testid="native-structure-preview-error">
        <Icon aria-hidden="true" />
        <div className="native-structure-preview__content"><span className="native-structure-preview__label">Preview unavailable</span><p>Could not load this {unavailableLabel(ref.kind)}.</p></div>
      </section>
    );
  }

  if (!result) {
    return (
      <section className="native-structure-preview" data-testid="native-structure-preview-loading" aria-busy="true">
        <Icon aria-hidden="true" />
        <div className="native-structure-preview__content"><span className="native-structure-preview__label">Loading {unavailableLabel(ref.kind)}</span></div>
      </section>
    );
  }

  if (!result.available) {
    return (
      <section className="native-structure-preview native-structure-preview--unavailable" data-testid="native-structure-preview-unavailable" data-reason={result.reason}>
        <Icon aria-hidden="true" />
        <div className="native-structure-preview__content"><span className="native-structure-preview__label">{unavailableLabel(result.kind)}</span><p>This structure is unavailable.</p></div>
      </section>
    );
  }

  return (
    <section className="native-structure-preview" data-testid="native-structure-preview" data-kind={result.kind}>
      <Icon aria-hidden="true" />
      <div className="native-structure-preview__content">
        <span className="native-structure-preview__label">{result.kindLabel}</span>
        <strong className="native-structure-preview__title">{result.title}</strong>
        <p className="native-structure-preview__excerpt">{result.excerpt}</p>
      </div>
      <button className="btn native-structure-preview__open" type="button" onClick={() => onOpen(ref, result)} aria-label={`Open ${result.kindLabel}: ${result.title}`}>
        Open
      </button>
    </section>
  );
});
