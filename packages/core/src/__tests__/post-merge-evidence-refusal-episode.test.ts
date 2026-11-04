/*
FNXC:PostMergeEvidenceRefusalEpisode 2026-11-02-18:16 (RUFU-450, Half 1):
The churn this bounds is measured, not hypothetical: VLLM-081 emitted 5
`task:auto-merge-finalize-column-mismatch-no-action` rows inside the single minute 19:44, then one at 19:43
and 19:45, and ZERO after an operator waived the gate — so the rows were pure restatement of a refusal that
could not be satisfied, at the poll rate, across process boundaries where the shipped in-process notice gate
holds nothing.

These cases are the bound itself: one record per floor for an unchanged refusal, an immediate record for a
changed one, and — the failure mode RUFU-442 measured and this must not repeat — a signature that stays
byte-stable while the counter grows. A bound whose key changes every cycle is not a bound.
*/
import { describe, expect, it } from "vitest";
import {
  POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY,
  POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS,
  clearPostMergeEvidenceRefusalPatch,
  decidePostMergeEvidenceRefusal,
  postMergeEvidenceRefusalAgeMs,
  postMergeEvidenceRefusalSignature,
  readPostMergeEvidenceRefusalEpisode,
  type PostMergeEvidenceRefusalEpisode,
} from "../merge/post-merge-evidence-refusal-episode.js";

const T0 = Date.parse("2026-11-02T12:00:00.000Z");
const GATE = "post-merge-verification";

function episode(overrides: Partial<PostMergeEvidenceRefusalEpisode> = {}): PostMergeEvidenceRefusalEpisode {
  return {
    signature: `${GATE}:missing:none`,
    lastAt: new Date(T0).toISOString(),
    firstAt: new Date(T0).toISOString(),
    refusalCount: 1,
    ...overrides,
  };
}

describe("post-merge evidence refusal signature", () => {
  it("names the refusal by gate, state, and re-seed refusal — and nothing else", () => {
    expect(postMergeEvidenceRefusalSignature({ gateId: GATE, state: "missing", reseedReason: null }))
      .toBe("post-merge-verification:missing:none");
    expect(postMergeEvidenceRefusalSignature({ gateId: GATE, state: "missing", reseedReason: "active-continuation" }))
      .toBe("post-merge-verification:missing:active-continuation");
  });

  it("keeps a growth counter OUT of the identity (RUFU-442): 30 records of one refusal share one key", () => {
    const first = episode({ refusalCount: 1 });
    const later = episode({ refusalCount: 30, lastAt: new Date(T0 + 60 * 60_000).toISOString() });
    expect(later.signature).toBe(first.signature);
  });
});

describe("decidePostMergeEvidenceRefusal — the refresh floor", () => {
  it("records the first refusal of an episode immediately", () => {
    const decision = decidePostMergeEvidenceRefusal(undefined, { gateId: GATE, state: "missing" }, T0);
    expect(decision).toMatchObject({ write: true, refresh: false });
    expect(decision.episode).toMatchObject({
      signature: `${GATE}:missing:none`,
      refusalCount: 1,
      gateId: GATE,
      state: "missing",
    });
    expect(decision.episode?.firstAt).toBe(decision.episode?.lastAt);
  });

  it("records a CHANGED refusal immediately, as a new episode", () => {
    const prior = episode();
    const changed = decidePostMergeEvidenceRefusal(
      prior,
      { gateId: GATE, state: "not-approved", reseedReason: "active-continuation" },
      T0 + 1_000,
    );
    expect(changed).toMatchObject({ write: true, refresh: false });
    expect(changed.episode?.signature).toBe(`${GATE}:not-approved:active-continuation`);
    expect(changed.episode?.refusalCount).toBe(1);
    // The new episode's clock starts now: the old episode's age describes a different refusal.
    expect(changed.episode?.firstAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it("withholds a record while an unchanged refusal is inside the floor, at any poll cadence", () => {
    const prior = episode();
    for (const offsetMs of [0, 1_000, 60_000, POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS - 1]) {
      expect(decidePostMergeEvidenceRefusal(prior, { gateId: GATE, state: "missing" }, T0 + offsetMs))
        .toEqual({ write: false, refresh: false });
    }
  });

  it("re-records an unchanged refusal once per floor and preserves when the wait began", () => {
    const prior = episode({ firstAt: new Date(T0).toISOString(), lastAt: new Date(T0).toISOString(), refusalCount: 3 });
    const atFloor = decidePostMergeEvidenceRefusal(prior, { gateId: GATE, state: "missing" }, T0 + POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS);
    expect(atFloor).toMatchObject({ write: true, refresh: true });
    expect(atFloor.episode).toMatchObject({ refusalCount: 4, signature: prior.signature });
    expect(atFloor.episode?.firstAt).toBe(prior.firstAt);
    expect(atFloor.episode?.lastAt).toBe(new Date(T0 + POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS).toISOString());
  });

  it("bounds a sustained refusal to the floor: 24h of one-second polling yields 96 records, not 86 400", () => {
    const dayMs = 24 * 60 * 60_000;
    let stored: PostMergeEvidenceRefusalEpisode | undefined;
    let records = 0;
    for (let elapsed = 0; elapsed <= dayMs; elapsed += 1_000) {
      const decision = decidePostMergeEvidenceRefusal(stored, { gateId: GATE, state: "missing" }, T0 + elapsed);
      if (decision.write && decision.episode) {
        records += 1;
        stored = decision.episode;
      }
    }
    expect(records).toBe(dayMs / POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS + 1);
    // And every one of them carried the SAME identity, which is what makes them one episode.
    expect(stored?.refusalCount).toBe(records);
  });

  it("reuses the shipped floor value rather than inventing a bound", () => {
    expect(POST_MERGE_EVIDENCE_REFUSAL_REFRESH_FLOOR_MS).toBe(15 * 60_000);
  });
});

describe("post-merge evidence refusal episode storage shape", () => {
  it("stores at a key-level patch site and clears key-level, never a whole-field write", () => {
    expect(POST_MERGE_EVIDENCE_REFUSAL_METADATA_KEY).toBe("postMergeEvidenceRefusal");
    expect(clearPostMergeEvidenceRefusalPatch()).toEqual({ postMergeEvidenceRefusal: null });
    // A whole-`sourceMetadata` write would orphan `duplicateOf`, `handoffFrom`, and the sibling episodes.
    expect(Object.keys(clearPostMergeEvidenceRefusalPatch())).toHaveLength(1);
  });

  it("fails open on a malformed stored payload instead of throwing during hydration", () => {
    for (const raw of [undefined, null, "x", 7, {}, { signature: "" }, { signature: "a:b:c" }, {
      signature: "a:b:c", lastAt: "not-a-date", firstAt: "not-a-date",
    }]) {
      expect(readPostMergeEvidenceRefusalEpisode(raw)).toBeUndefined();
    }
  });

  it("repairs a missing or absurd counter without dropping the episode", () => {
    const repaired = readPostMergeEvidenceRefusalEpisode({ signature: "a:b:c", lastAt: "2026-11-02T12:00:00.000Z", firstAt: "2026-11-02T11:00:00.000Z", refusalCount: -5 });
    expect(repaired?.refusalCount).toBe(0);
    expect(readPostMergeEvidenceRefusalEpisode({ signature: "a:b:c", lastAt: "2026-11-02T12:00:00.000Z", firstAt: "2026-11-02T11:00:00.000Z" })?.refusalCount).toBe(0);
  });

  it("derives the age of an episode from the field that proves its start, never from the row clock (RUFU-350)", () => {
    const stored = episode({ firstAt: new Date(T0).toISOString() });
    expect(postMergeEvidenceRefusalAgeMs(stored, T0 + 45 * 60_000)).toBe(45 * 60_000);
    expect(postMergeEvidenceRefusalAgeMs({ ...stored, firstAt: "garbage" }, T0)).toBe(0);
  });
});
