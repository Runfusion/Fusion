import "./SecretsView.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Eye, EyeOff, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";

type ToastKind = "info" | "success" | "error";
type SecretScope = "project" | "global";
type SecretPolicy = "auto" | "prompt" | "deny";

interface SecretRecord {
  id: string;
  scope: SecretScope;
  key: string;
  description: string | null;
  accessPolicy: SecretPolicy;
  envExportable: boolean;
  envExportKey: string | null;
  lastReadAt: string | null;
}

interface SecretsViewProps {
  addToast?: (msg: string, kind?: ToastKind) => void;
}

const RESERVED_SYNC_PASSPHRASE_KEY = "__sync_passphrase__";

interface SecretFormState {
  key: string;
  value: string;
  description: string;
  scope: SecretScope;
  accessPolicy: SecretPolicy;
  envExportable: boolean;
  envExportKey: string;
}

const EMPTY_FORM: SecretFormState = {
  key: "",
  value: "",
  description: "",
  scope: "project",
  accessPolicy: "prompt",
  envExportable: false,
  envExportKey: "",
};

const actionIconProps = {
  className: "secrets-action-icon",
  "aria-hidden": true,
  style: { width: "1em", height: "1em" },
} as const;

const spinningActionIconProps = {
  ...actionIconProps,
  className: "secrets-action-icon spin",
} as const;

export const SecretsView = ({ addToast }: SecretsViewProps) => {
  const [secrets, setSecrets] = useState<SecretRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SecretRecord | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [showDeleteId, setShowDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState<SecretFormState>(EMPTY_FORM);
  const [showValue, setShowValue] = useState(false);
  const [revealedValues, setRevealedValues] = useState<Record<string, string | null>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [syncPassphraseConfigured, setSyncPassphraseConfigured] = useState(false);
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncPassphrase, setSyncPassphrase] = useState("");
  const [syncPassphraseConfirm, setSyncPassphraseConfirm] = useState("");
  const [syncSaving, setSyncSaving] = useState(false);
  const revealTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const copyTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const request = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Request failed" }));
      throw new Error(String(payload?.error ?? "Request failed"));
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }, []);

  const loadSecrets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await request<{ secrets: SecretRecord[] }>("/api/secrets");
      setSecrets(data.secrets);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [request]);

  const loadSyncPassphraseStatus = useCallback(async () => {
    try {
      const data = await request<{ configured: boolean }>("/api/secrets/sync-passphrase");
      setSyncPassphraseConfigured(Boolean(data.configured));
    } catch (err) {
      addToast?.(`Failed to load sync passphrase status: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [addToast, request]);

  useEffect(() => {
    void loadSecrets();
    void loadSyncPassphraseStatus();
    return () => {
      revealTimersRef.current.forEach((timer) => clearTimeout(timer));
      copyTimersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, [loadSecrets, loadSyncPassphraseStatus]);

  const closeSyncModal = () => {
    setSyncModalOpen(false);
    setSyncPassphrase("");
    setSyncPassphraseConfirm("");
  };

  const saveSyncPassphrase = async (passphrase: string) => {
    await request<{ success: boolean }>("/api/secrets/sync-passphrase", {
      method: "PUT",
      body: JSON.stringify({ passphrase }),
    });
  };

  const submitSyncPassphrase = async () => {
    setSyncSaving(true);
    try {
      await saveSyncPassphrase(syncPassphrase);
      addToast?.(syncPassphraseConfigured ? "Sync passphrase rotated" : "Sync passphrase set", "success");
      closeSyncModal();
      await loadSyncPassphraseStatus();
    } catch (err) {
      addToast?.(`Failed to save sync passphrase: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setSyncSaving(false);
    }
  };

  const clearSyncPassphraseHandler = async () => {
    const confirmed = window.confirm("Clear the cross-node sync passphrase? Existing sync pairs will stop working until you set a new passphrase.");
    if (!confirmed) return;
    try {
      await request<{ success: boolean }>("/api/secrets/sync-passphrase", { method: "DELETE" });
      addToast?.("Sync passphrase cleared", "success");
      await loadSyncPassphraseStatus();
    } catch (err) {
      addToast?.(`Failed to clear sync passphrase: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowModal(true);
    setShowValue(false);
    setFormError(null);
  };

  const openEdit = (secret: SecretRecord) => {
    setEditing(secret);
    setForm({
      key: secret.key,
      value: "",
      description: secret.description ?? "",
      scope: secret.scope,
      accessPolicy: secret.accessPolicy,
      envExportable: secret.envExportable,
      envExportKey: secret.envExportKey ?? "",
    });
    setShowModal(true);
    setShowValue(false);
    setFormError(null);
  };

  const submit = async () => {
    setFormError(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = {
          key: form.key,
          description: form.description || null,
          accessPolicy: form.accessPolicy,
          envExportable: form.envExportable,
          envExportKey: form.envExportable ? (form.envExportKey || null) : null,
        };
        if (form.value) body.value = form.value;
        await request(`/api/secrets/${editing.scope}/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await request("/api/secrets", {
          method: "POST",
          body: JSON.stringify({
            scope: form.scope,
            key: form.key,
            value: form.value,
            description: form.description || null,
            accessPolicy: form.accessPolicy,
            envExportable: form.envExportable,
            envExportKey: form.envExportable ? (form.envExportKey || null) : null,
          }),
        });
      }
      setShowModal(false);
      setForm(EMPTY_FORM);
      await loadSecrets();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const revealSecret = async (secret: SecretRecord) => {
    const data = await request<{ key: string; value: string }>(`/api/secrets/${secret.scope}/${secret.id}/reveal`, { method: "POST" });
    setRevealedValues((current) => ({ ...current, [secret.id]: data.value }));
    addToast?.("Revealed", "success");
    const timer = setTimeout(() => {
      setRevealedValues((current) => ({ ...current, [secret.id]: null }));
    }, 30000);
    const existing = revealTimersRef.current.get(secret.id);
    if (existing) clearTimeout(existing);
    revealTimersRef.current.set(secret.id, timer);
  };

  const copySecret = async (secret: SecretRecord) => {
    const revealed = revealedValues[secret.id];
    if (!revealed) return;
    await navigator.clipboard.writeText(revealed);
    setCopiedId(secret.id);
    addToast?.("Copied", "success");
    const timer = setTimeout(() => {
      setCopiedId(null);
      setRevealedValues((current) => ({ ...current, [secret.id]: null }));
    }, 1500);
    const existing = copyTimersRef.current.get(secret.id);
    if (existing) clearTimeout(existing);
    copyTimersRef.current.set(secret.id, timer);
  };

  const deleteSecret = async (secret: SecretRecord) => {
    await request(`/api/secrets/${secret.scope}/${secret.id}`, { method: "DELETE" });
    setShowDeleteId(null);
    await loadSecrets();
  };

  const sortedSecrets = useMemo(
    () => [...secrets]
      .filter((secret) => !(secret.scope === "global" && secret.key === RESERVED_SYNC_PASSPHRASE_KEY))
      .sort((a, b) => a.key.localeCompare(b.key)),
    [secrets],
  );

  const syncPassphraseMatches = syncPassphrase.length > 0 && syncPassphrase === syncPassphraseConfirm;

  return (
    <section className="secrets-view">
      <div className="secrets-header">
        <h2>Secrets</h2>
        <div className="secrets-header-actions">
          <button className="btn btn-sm" onClick={() => void loadSecrets()}><RefreshCw {...actionIconProps} /> Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={openCreate}><Plus {...actionIconProps} /> Add Secret</button>
        </div>
      </div>

      <article className="card secrets-sync-card">
        <div className="secrets-sync-header">
          <div>
            <h3>Cross-Node Sync Passphrase</h3>
            <p className="secrets-sync-status"><span className={`status-dot ${syncPassphraseConfigured ? "status-dot--online" : "status-dot--pending"}`} aria-hidden="true" /> {syncPassphraseConfigured ? "Configured" : "Not configured"}</p>
          </div>
          <div className="secrets-sync-actions">
            <button className="btn" onClick={() => setSyncModalOpen(true)}>{syncPassphraseConfigured ? "Rotate" : "Set passphrase"}</button>
            {syncPassphraseConfigured ? <button className="btn btn-danger" onClick={() => void clearSyncPassphraseHandler()}>Clear</button> : null}
          </div>
        </div>
        <p className="secrets-sync-copy">
          Shared passphrase used to wrap cross-node secret bundles. Both nodes in a sync pair must share the same value. Stored locally only; never transmitted.
        </p>
      </article>

      {error ? <div className="form-error">{error}</div> : null}
      {loading ? <div className="secrets-loading"><RefreshCw {...spinningActionIconProps} /> Loading…</div> : null}
      {!loading && sortedSecrets.length === 0 ? <div className="secrets-empty">No secrets found.</div> : null}

      <div className="secrets-list">
        {sortedSecrets.map((secret) => {
          const revealed = revealedValues[secret.id];
          return (
            <article key={secret.id} className="card secrets-row">
              <div className="secrets-row-main">
                <div className="secrets-row-key">{secret.key}</div>
                <div className="secrets-row-meta">
                  <span className="secrets-chip">{secret.scope}</span>
                  <span className="secrets-chip">{secret.accessPolicy}</span>
                  {secret.envExportable ? <span className="secrets-chip">env_exportable</span> : null}
                </div>
                {revealed ? <pre className="secrets-revealed">{revealed}</pre> : null}
              </div>
              <div className="secrets-row-side">
                <span className="secrets-row-read">{secret.lastReadAt ? new Date(secret.lastReadAt).toLocaleString() : "Never read"}</span>
                <div className="secrets-row-actions">
                  <button
                    type="button"
                    className="btn btn-icon secrets-visibility-toggle"
                    onClick={() => void revealSecret(secret)}
                    aria-label={revealed ? "Hide" : "Reveal"}
                  >
                    {revealed ? <EyeOff {...actionIconProps} /> : <Eye {...actionIconProps} />}
                  </button>
                  <button className="btn btn-icon" onClick={() => void copySecret(secret)} aria-label="Copy" disabled={!revealed}>
                    {copiedId === secret.id ? <Check {...actionIconProps} /> : <Copy {...actionIconProps} />}
                  </button>
                  <button className="btn btn-icon" onClick={() => openEdit(secret)} aria-label="Edit"><Pencil {...actionIconProps} /></button>
                  <button className="btn btn-icon btn-danger" onClick={() => setShowDeleteId(secret.id)} aria-label="Delete"><Trash2 {...actionIconProps} /></button>
                </div>
                {showDeleteId === secret.id ? (
                  <div className="secrets-confirm">
                    <button className="btn btn-sm btn-danger" onClick={() => void deleteSecret(secret)}>Confirm</button>
                    <button className="btn btn-sm" onClick={() => setShowDeleteId(null)}>Cancel</button>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {syncModalOpen ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={syncPassphraseConfigured ? "Rotate sync passphrase" : "Set sync passphrase"}>
            <div className="modal-header">
              <h3>{syncPassphraseConfigured ? "Rotate sync passphrase" : "Set sync passphrase"}</h3>
              <button className="modal-close" onClick={closeSyncModal} aria-label="Close">×</button>
            </div>
            <div className="secrets-modal-body">
              <div className="form-group"><label>Passphrase</label><input aria-label="Passphrase" className="input" type="password" autoComplete="new-password" value={syncPassphrase} onChange={(e) => setSyncPassphrase(e.target.value)} /></div>
              <div className="form-group"><label>Confirm passphrase</label><input aria-label="Confirm passphrase" className="input" type="password" autoComplete="new-password" value={syncPassphraseConfirm} onChange={(e) => setSyncPassphraseConfirm(e.target.value)} /></div>
              {!syncPassphraseMatches && syncPassphraseConfirm.length > 0 ? <div className="form-error">Passphrases must match.</div> : null}
            </div>
            <div className="modal-actions"><div className="modal-actions-right"><button className="btn" onClick={closeSyncModal}>Cancel</button><button className="btn btn-primary" onClick={() => void submitSyncPassphrase()} disabled={!syncPassphraseMatches || syncSaving}>{syncPassphraseConfigured ? "Rotate" : "Set passphrase"}</button></div></div>
          </div>
        </div>
      ) : null}

      {showModal ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? "Edit secret" : "Add secret"}>
            <div className="modal-header">
              <h3>{editing ? "Edit secret" : "Add secret"}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)} aria-label="Close">×</button>
            </div>
            <div className="secrets-modal-body">
              <div className="form-group"><label>Key</label><input className="input" value={form.key} onChange={(e) => setForm((c) => ({ ...c, key: e.target.value }))} /></div>
              <div className="form-group"><label>Value</label><div className="secrets-value-row"><input className="input" type={showValue ? "text" : "password"} autoComplete="off" spellCheck={false} value={form.value} onChange={(e) => setForm((c) => ({ ...c, value: e.target.value }))} /><button type="button" className="btn btn-icon secrets-visibility-toggle" onClick={() => setShowValue((s) => !s)} aria-label={showValue ? "Hide value" : "Show value"}>{showValue ? <EyeOff {...actionIconProps} /> : <Eye {...actionIconProps} />}</button></div></div>
              <div className="form-group"><label>Description</label><textarea className="input" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} /></div>
              <div className="form-group"><label>Scope</label><div className="secrets-radio-row"><label><input type="radio" checked={form.scope === "project"} onChange={() => setForm((c) => ({ ...c, scope: "project" }))} disabled={Boolean(editing)} /> Project</label><label><input type="radio" checked={form.scope === "global"} onChange={() => setForm((c) => ({ ...c, scope: "global" }))} disabled={Boolean(editing)} /> Global</label></div></div>
              <div className="form-group"><label>Access policy</label><select className="select" value={form.accessPolicy} onChange={(e) => setForm((c) => ({ ...c, accessPolicy: e.target.value as SecretPolicy }))}><option value="auto">auto</option><option value="prompt">prompt</option><option value="deny">deny</option></select></div>
              <div className="form-group"><label className="checkbox-label"><input type="checkbox" checked={form.envExportable} onChange={(e) => setForm((c) => ({ ...c, envExportable: e.target.checked }))} /> Export to env</label></div>
              {form.envExportable ? <div className="form-group"><label>Env key</label><input className="input" value={form.envExportKey} onChange={(e) => setForm((c) => ({ ...c, envExportKey: e.target.value }))} /></div> : null}
              {formError ? <div className="form-error">{formError}</div> : null}
            </div>
            <div className="modal-actions"><div className="modal-actions-right"><button className="btn" onClick={() => setShowModal(false)}>Cancel</button><button className="btn btn-primary" onClick={() => void submit()}>{editing ? "Save" : "Create"}</button></div></div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
