import { useMemo, useState } from "react";
import { BasicsStep, CredentialsStep, EndpointsStep, TransportStep } from "../wizard/steps.js";
import type { ServiceDraft, WizardStep } from "../wizard/types.js";
import { validateBasics, validateCredentials, validateDraft, validateEndpoints, validateTransport } from "../wizard/validation.js";

const STEPS: WizardStep[] = ["basics", "transport", "endpoints", "credentials", "review"];

export function EditDraftModal({
  initialDraft,
  onClose,
  onSave,
}: {
  initialDraft: ServiceDraft;
  onClose: () => void;
  onSave: (draft: ServiceDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ServiceDraft>(initialDraft);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const currentStep = STEPS[stepIndex];
  const currentValidation = useMemo(() => {
    if (currentStep === "basics") return validateBasics(draft);
    if (currentStep === "transport") return validateTransport(draft);
    if (currentStep === "endpoints") return validateEndpoints(draft);
    if (currentStep === "credentials") return validateCredentials(draft.credential);
    return { ok: true } as const;
  }, [currentStep, draft]);

  async function saveDraft() {
    const validation = validateDraft(draft);
    if (!validation.ok) {
      setError(Object.values(validation.errors)[0] ?? "Draft validation failed");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save draft");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true">
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2>Edit Service CLI Draft</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close edit modal">×</button>
        </div>
        {error ? <p className="form-error">{error}</p> : null}

        {currentStep === "basics" ? <BasicsStep draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} /> : null}
        {currentStep === "transport" ? <TransportStep /> : null}
        {currentStep === "endpoints" ? <EndpointsStep draft={draft} onChange={(endpoints) => setDraft((current) => ({ ...current, endpoints }))} /> : null}
        {currentStep === "credentials" ? <CredentialsStep draft={draft} onChange={(credential) => setDraft((current) => ({ ...current, credential }))} /> : null}
        {currentStep === "review" ? <pre className="card cli-press-manage-json-preview">{JSON.stringify(draft, null, 2)}</pre> : null}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={stepIndex === 0 || saving} onClick={() => setStepIndex((value) => Math.max(0, value - 1))}>Back</button>
          {stepIndex < STEPS.length - 1 ? (
            <button className="btn btn-primary" disabled={!currentValidation.ok || saving} onClick={() => setStepIndex((value) => Math.min(STEPS.length - 1, value + 1))}>Next</button>
          ) : (
            <button className="btn btn-primary" disabled={saving} onClick={() => void saveDraft()}>{saving ? "Saving…" : "Save"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
