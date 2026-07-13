import "./SecretsView.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Copy, Eye, EyeOff, Lock, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { ViewHeader } from "./ViewHeader";
import { copyTextToClipboard } from "../utils/copyToClipboard";

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
  const { t } = useTranslation("app");
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
  /*
  FNXC:Secrets 2026-06-23-01:30:
  The cross-node sync passphrase is an advanced, rarely-touched setting, so it now lives BELOW the secrets list and is
  collapsed behind a disclosure that is closed by default. Users click the toggle to expand the passphrase status/actions
  + description. All set/rotate/clear functionality is unchanged; only relocated and gated behind this toggle.
  */
  const [syncDisclosureOpen, setSyncDisclosureOpen] = useState(false);
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
      addToast?.(t("secrets.errorLoadSyncStatus", "Failed to load sync passphrase status: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
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
      addToast?.(syncPassphraseConfigured ? t("secrets.syncPassphraseRotated", "Sync passphrase rotated") : t("secrets.syncPassphraseSet", "Sync passphrase set"), "success");
      closeSyncModal();
      await loadSyncPassphraseStatus();
    } catch (err) {
      addToast?.(t("secrets.errorSaveSyncPassphrase", "Failed to save sync passphrase: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
    } finally {
      setSyncSaving(false);
    }
  };

  const clearSyncPassphraseHandler = async () => {
    const confirmed = window.confirm(t("secrets.confirmClearSyncPassphrase", "Clear the cross-node sync passphrase? Existing sync pairs will stop working until you set a new passphrase."));
    if (!confirmed) return;
    try {
      await request<{ success: boolean }>("/api/secrets/sync-passphrase", { method: "DELETE" });
      addToast?.(t("secrets.syncPassphraseCleared", "Sync passphrase cleared"), "success");
      await loadSyncPassphraseStatus();
    } catch (err) {
      addToast?.(t("secrets.errorClearSyncPassphrase", "Failed to clear sync passphrase: {{error}}", { error: err instanceof Error ? err.message : String(err) }), "error");
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

  const hideSecret = (secret: SecretRecord) => {
    const existing = revealTimersRef.current.get(secret.id);
    if (existing) {
      clearTimeout(existing);
      revealTimersRef.current.delete(secret.id);
    }
    setRevealedValues((current) => ({ ...current, [secret.id]: null }));
  };

  const revealSecret = async (secret: SecretRecord) => {
    const data = await request<{ key: string; value: string }>(`/api/secrets/${secret.scope}/${secret.id}/reveal`, { method: "POST" });
    setRevealedValues((current) => ({ ...current, [secret.id]: data.value }));
    addToast?.(t("secrets.revealed", "Revealed"), "success");
    const timer = setTimeout(() => {
      setRevealedValues((current) => ({ ...current, [secret.id]: null }));
      revealTimersRef.current.delete(secret.id);
    }, 30000);
    const existing = revealTimersRef.current.get(secret.id);
    if (existing) clearTimeout(existing);
    revealTimersRef.current.set(secret.id, timer);
  };

  /*
  FNXC:Clipboard 2026-07-12-00:00:
  Direct navigator.clipboard.writeText crashes or mis-reports on non-secure origins such as mobile http://fusionstudio:4040; copyTextToClipboard centralizes the secure-context guard and execCommand fallback.
  */
  const copySecret = async (secret: SecretRecord) => {
    const revealed = revealedValues[secret.id];
    if (!revealed) return;
    const copied = await copyTextToClipboard(revealed);
    if (!copied) {
      addToast?.(t("secrets.copyFailed", "Failed to copy secret"), "error");
      return;
    }
    setCopiedId(secret.id);
    addToast?.(t("secrets.copied", "Copied"), "success");
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
      {/*
        FNXC:ViewHeader 2026-06-23-03:45:
        Secrets now renders the shared canonical ViewHeader (Lock icon matches the right-dock nav). The Refresh/Add actions ride in the header actions cluster as btn btn-sm so they match every other view's header buttons. The right-dock/pop-out hosts still hide this title row via the `.secrets-view > .view-header` selector since those chromes label the view themselves.
      */}
      <ViewHeader
        icon={Lock}
        title={t("secrets.title", "Secrets")}
        actions={
          <>
            <button className="btn btn-sm" onClick={() => void loadSecrets()}><RefreshCw {...actionIconProps} /> {t("secrets.refresh", "Refresh")}</button>
            <button className="btn btn-primary btn-sm" onClick={openCreate}><Plus {...actionIconProps} /> {t("secrets.addSecret", "Add Secret")}</button>
          </>
        }
      />

      {error ? <div className="form-error">{error}</div> : null}
      {loading ? <div className="secrets-loading"><RefreshCw {...spinningActionIconProps} /> {t("secrets.loading", "Loading…")}</div> : null}
      {!loading && sortedSecrets.length === 0 ? <div className="secrets-empty">{t("secrets.empty", "No secrets found.")}</div> : null}

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
                  {secret.envExportable ? <span className="secrets-chip">{t("secrets.envExportableChip", "env exportable")}</span> : null}
                </div>
                {revealed ? <pre className="secrets-revealed">{revealed}</pre> : null}
              </div>
              <div className="secrets-row-side">
                <span className="secrets-row-read">{secret.lastReadAt ? new Date(secret.lastReadAt).toLocaleString() : t("secrets.neverRead", "Never read")}</span>
                <div className="secrets-row-actions">
                  <button
                    type="button"
                    className="btn btn-icon secrets-visibility-toggle"
                    onClick={() => {
                      if (revealed) {
                        hideSecret(secret);
                        return;
                      }
                      void revealSecret(secret);
                    }}
                    aria-label={revealed ? t("secrets.hideAriaLabel", "Hide") : t("secrets.revealAriaLabel", "Reveal")}
                  >
                    {revealed ? <EyeOff {...actionIconProps} /> : <Eye {...actionIconProps} />}
                  </button>
                  <button className="btn btn-icon" onClick={() => void copySecret(secret)} aria-label={t("secrets.copyAriaLabel", "Copy")} disabled={!revealed}>
                    {copiedId === secret.id ? <Check {...actionIconProps} /> : <Copy {...actionIconProps} />}
                  </button>
                  <button className="btn btn-icon" onClick={() => openEdit(secret)} aria-label={t("secrets.editAriaLabel", "Edit")}><Pencil {...actionIconProps} /></button>
                  <button className="btn btn-icon btn-danger" onClick={() => setShowDeleteId(secret.id)} aria-label={t("secrets.deleteAriaLabel", "Delete")}><Trash2 {...actionIconProps} /></button>
                </div>
                {showDeleteId === secret.id ? (
                  <div className="secrets-confirm">
                    <button className="btn btn-sm btn-danger" onClick={() => void deleteSecret(secret)}>{t("secrets.confirmDelete", "Confirm")}</button>
                    <button className="btn btn-sm" onClick={() => setShowDeleteId(null)}>{t("secrets.cancelDelete", "Cancel")}</button>
                  </div>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>

      {/*
        FNXC:Secrets 2026-06-23-01:30:
        Disclosure (closed by default) sits below the secrets list. The toggle button carries aria-expanded/aria-controls
        and a rotating chevron; the passphrase status, set/rotate/clear actions, and description only render when expanded.
      */}
      <article className="card secrets-sync-card secrets-sync-disclosure">
        <button
          type="button"
          className="secrets-sync-disclosure-toggle"
          data-testid="secrets-passphrase-disclosure"
          aria-expanded={syncDisclosureOpen}
          aria-controls="secrets-sync-disclosure-panel"
          onClick={() => setSyncDisclosureOpen((open) => !open)}
        >
          {syncDisclosureOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          <span>{t("secrets.syncPassphraseTitle", "Cross-Node Sync Passphrase")}</span>
        </button>
        {syncDisclosureOpen ? (
          <div id="secrets-sync-disclosure-panel" className="secrets-sync-disclosure-panel">
            <div className="secrets-sync-header">
              <p className="secrets-sync-status"><span className={`status-dot ${syncPassphraseConfigured ? "status-dot--online" : "status-dot--pending"}`} aria-hidden="true" /> {syncPassphraseConfigured ? t("secrets.syncConfigured", "Configured") : t("secrets.syncNotConfigured", "Not configured")}</p>
              <div className="secrets-sync-actions">
                <button className="btn" onClick={() => setSyncModalOpen(true)}>{syncPassphraseConfigured ? t("secrets.rotateSyncPassphrase", "Rotate") : t("secrets.setPassphrase", "Set passphrase")}</button>
                {syncPassphraseConfigured ? <button className="btn btn-danger" onClick={() => void clearSyncPassphraseHandler()}>{t("secrets.clearSyncPassphrase", "Clear")}</button> : null}
              </div>
            </div>
            <p className="secrets-sync-copy">
              {t("secrets.syncPassphraseDescription", "Shared passphrase used to wrap cross-node secret bundles. Both nodes in a sync pair must share the same value. Stored locally only; never transmitted.")}
            </p>
          </div>
        ) : null}
      </article>

      {syncModalOpen ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={syncPassphraseConfigured ? t("secrets.rotateSyncPassphraseModalTitle", "Rotate sync passphrase") : t("secrets.setSyncPassphraseModalTitle", "Set sync passphrase")}>
            <div className="modal-header">
              <h3>{syncPassphraseConfigured ? t("secrets.rotateSyncPassphraseModalTitle", "Rotate sync passphrase") : t("secrets.setSyncPassphraseModalTitle", "Set sync passphrase")}</h3>
              <button className="modal-close" onClick={closeSyncModal} aria-label={t("secrets.closeAriaLabel", "Close")}>×</button>
            </div>
            <div className="secrets-modal-body">
              <div className="form-group"><label>{t("secrets.passphraseLabel", "Passphrase")}</label><input aria-label={t("secrets.passphraseLabel", "Passphrase")} className="input" type="password" autoComplete="new-password" value={syncPassphrase} onChange={(e) => setSyncPassphrase(e.target.value)} /></div>
              <div className="form-group"><label>{t("secrets.confirmPassphraseLabel", "Confirm passphrase")}</label><input aria-label={t("secrets.confirmPassphraseLabel", "Confirm passphrase")} className="input" type="password" autoComplete="new-password" value={syncPassphraseConfirm} onChange={(e) => setSyncPassphraseConfirm(e.target.value)} /></div>
              {!syncPassphraseMatches && syncPassphraseConfirm.length > 0 ? <div className="form-error">{t("secrets.passphraseMustMatch", "Passphrases must match.")}</div> : null}
            </div>
            <div className="modal-actions"><div className="modal-actions-right"><button className="btn" onClick={closeSyncModal}>{t("secrets.cancelBtn", "Cancel")}</button><button className="btn btn-primary" onClick={() => void submitSyncPassphrase()} disabled={!syncPassphraseMatches || syncSaving}>{syncPassphraseConfigured ? t("secrets.rotateSyncPassphrase", "Rotate") : t("secrets.setPassphrase", "Set passphrase")}</button></div></div>
          </div>
        </div>
      ) : null}

      {showModal ? (
        <div className="modal-overlay open" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label={editing ? t("secrets.editSecretModalTitle", "Edit secret") : t("secrets.addSecretModalTitle", "Add secret")}>
            <div className="modal-header">
              <h3>{editing ? t("secrets.editSecretModalTitle", "Edit secret") : t("secrets.addSecretModalTitle", "Add secret")}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)} aria-label={t("secrets.closeAriaLabel", "Close")}>×</button>
            </div>
            <div className="secrets-modal-body">
              <div className="form-group"><label>{t("secrets.keyLabel", "Key")}</label><input className="input" value={form.key} onChange={(e) => setForm((c) => ({ ...c, key: e.target.value }))} /></div>
              <div className="form-group"><label>{t("secrets.valueLabel", "Value")}</label><div className="secrets-value-row"><input className="input" type={showValue ? "text" : "password"} autoComplete="off" spellCheck={false} value={form.value} onChange={(e) => setForm((c) => ({ ...c, value: e.target.value }))} /><button type="button" className="btn btn-icon secrets-visibility-toggle" onClick={() => setShowValue((s) => !s)} aria-label={showValue ? t("secrets.hideValueAriaLabel", "Hide value") : t("secrets.showValueAriaLabel", "Show value")}>{showValue ? <EyeOff {...actionIconProps} /> : <Eye {...actionIconProps} />}</button></div></div>
              <div className="form-group"><label>{t("secrets.descriptionLabel", "Description")}</label><textarea className="input" value={form.description} onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))} /></div>
              <div className="form-group"><label>{t("secrets.scopeLabel", "Scope")}</label><div className="secrets-radio-row"><label><input type="radio" checked={form.scope === "project"} onChange={() => setForm((c) => ({ ...c, scope: "project" }))} disabled={Boolean(editing)} /> {t("secrets.scopeProject", "Project")}</label><label><input type="radio" checked={form.scope === "global"} onChange={() => setForm((c) => ({ ...c, scope: "global" }))} disabled={Boolean(editing)} /> {t("secrets.scopeGlobal", "Global")}</label></div></div>
              <div className="form-group"><label>{t("secrets.accessPolicyLabel", "Access policy")}</label><select className="select" value={form.accessPolicy} onChange={(e) => setForm((c) => ({ ...c, accessPolicy: e.target.value as SecretPolicy }))}><option value="auto">{t("secrets.accessPolicyAuto", "auto")}</option><option value="prompt">{t("secrets.accessPolicyPrompt", "prompt")}</option><option value="deny">{t("secrets.accessPolicyDeny", "deny")}</option></select></div>
              <div className="form-group"><label className="checkbox-label"><input type="checkbox" checked={form.envExportable} onChange={(e) => setForm((c) => ({ ...c, envExportable: e.target.checked }))} /> {t("secrets.exportToEnvLabel", "Export to env")}</label></div>
              {form.envExportable ? <div className="form-group"><label>{t("secrets.envKeyLabel", "Env key")}</label><input className="input" value={form.envExportKey} onChange={(e) => setForm((c) => ({ ...c, envExportKey: e.target.value }))} /></div> : null}
              {formError ? <div className="form-error">{formError}</div> : null}
            </div>
            <div className="modal-actions"><div className="modal-actions-right"><button className="btn" onClick={() => setShowModal(false)}>{t("secrets.cancelBtn", "Cancel")}</button><button className="btn btn-primary" onClick={() => void submit()}>{editing ? t("secrets.saveBtn", "Save") : t("secrets.createBtn", "Create")}</button></div></div>
          </div>
        </div>
      ) : null}
    </section>
  );
};
