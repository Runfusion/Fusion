import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import { useMemo, useState } from "react";
import { BasicsStep, CredentialsStep, EndpointsStep, ReviewStep, TransportStep } from "./wizard/steps.js";
import type { ServiceDraft, WizardStep } from "./wizard/types.js";
import { validateBasics, validateCredentials, validateEndpoints, validateTransport } from "./wizard/validation.js";
import "./dashboard-view.css";

const STEPS: WizardStep[] = ["basics", "transport", "endpoints", "credentials", "review"];

function createInitialDraft(): ServiceDraft {
  const now = new Date().toISOString();
  return { id: "", name: "", slug: "", description: "", baseUrl: "", transport: "http", endpoints: [{ id: crypto.randomUUID(), name: "", method: "GET", path: "" }], credential: { kind: "none" }, createdAt: now, updatedAt: now };
}

export function CliPrintingPressWizardView({ context: _context }: { context?: PluginDashboardViewContext }) {
  const [draft, setDraft] = useState<ServiceDraft>(() => createInitialDraft());
  const [stepIndex, setStepIndex] = useState(0);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const currentStep = STEPS[stepIndex];
  const currentValidation = useMemo(() => {
    if (currentStep === "basics") return validateBasics(draft);
    if (currentStep === "transport") return validateTransport(draft);
    if (currentStep === "endpoints") return validateEndpoints(draft);
    if (currentStep === "credentials") return validateCredentials(draft.credential);
    return { ok: true } as const;
  }, [currentStep, draft]);

  async function onSave() {
    const response = await fetch("/api/plugins/fusion-plugin-cli-printing-press/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
    if (!response.ok) {
      const body = await response.json().catch(() => ({} as { error?: string; errors?: Record<string, string> }));
      const firstError = body?.errors ? Object.values(body.errors)[0] : undefined;
      setError(body?.error ?? firstError ?? "Failed to save draft");
      return;
    }
    const body = await response.json();
    setSavedId(body.id);
  }

  if (savedId) {
    return <section className="card"><h2>Saved — draft id {savedId}</h2><p>List, edit, regenerate, run/test, and runtime exposure land in FN-3764 / FN-3765 / FN-3767.</p></section>;
  }

  return <section className="cli-press-wizard"><div className="cli-press-stepper">{STEPS.map((step, index) => <span className={`cli-press-step${index === stepIndex ? " is-active" : ""}`} key={step}>{step}</span>)}</div>{error ? <p className="form-error">{error}</p> : null}{currentStep === "basics" ? <BasicsStep draft={draft} onChange={(patch) => setDraft((current) => ({ ...current, ...patch, updatedAt: new Date().toISOString() }))} /> : null}{currentStep === "transport" ? <TransportStep /> : null}{currentStep === "endpoints" ? <EndpointsStep draft={draft} onChange={(endpoints) => setDraft((current) => ({ ...current, endpoints, updatedAt: new Date().toISOString() }))} /> : null}{currentStep === "credentials" ? <CredentialsStep draft={draft} onChange={(credential) => setDraft((current) => ({ ...current, credential, updatedAt: new Date().toISOString() }))} /> : null}{currentStep === "review" ? <ReviewStep draft={draft} /> : null}<div className="cli-press-actions"><button className="btn" onClick={() => setDraft(createInitialDraft())}>Cancel</button><button className="btn" disabled={stepIndex === 0} onClick={() => setStepIndex((value) => Math.max(0, value - 1))}>Back</button>{stepIndex < STEPS.length - 1 ? <button className="btn btn-primary" disabled={!currentValidation.ok} onClick={() => setStepIndex((value) => Math.min(STEPS.length - 1, value + 1))}>Next</button> : <button className="btn btn-primary" onClick={() => void onSave()}>Save draft</button>}</div></section>;
}

export default CliPrintingPressWizardView;
