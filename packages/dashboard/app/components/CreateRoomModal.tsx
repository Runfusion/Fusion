import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { fetchAgents } from "../api";
import type { Agent } from "@fusion/core";
import { AgentAvatar } from "./AgentAvatar";
import { LoadingSpinner } from "./LoadingSpinner";
import "./CreateRoomModal.css";

export interface RoomDraft {
  /** Slack-style display name without leading "#" (e.g. "engineering"). Lowercase. */
  name: string;
  /** Display form including the leading "#" (e.g. "#engineering"). */
  displayName: string;
  /** Agent IDs selected as initial members. */
  memberAgentIds: string[];
}

export function validateRoomName(input: string, existingRoomNames: string[] = [], t?: (key: string, defaultValue: string) => string): { ok: true; name: string } | { ok: false; error: string } {
  const raw = input.trim().replace(/^#/, "");
  const getError = (key: string, defaultValue: string) => t ? t(key, defaultValue) : defaultValue;
  if (!raw) return { ok: false, error: getError("createRoom.nameRequired", "Room name is required.") };
  if (/[A-Z]/.test(raw)) return { ok: false, error: getError("createRoom.lowercase", "Use lowercase letters only.") };
  const stripped = raw.toLowerCase();
  if (stripped.length > 80) return { ok: false, error: getError("createRoom.maxLength", "Room names can be at most 80 characters.") };
  if (!/^[a-z0-9_-]+$/.test(stripped)) return { ok: false, error: getError("createRoom.validChars", "Use lowercase letters, numbers, hyphens, or underscores only.") };
  if (/^[-_]|[-_]$/.test(stripped)) return { ok: false, error: getError("createRoom.noEdgeChars", "Room names cannot start or end with a hyphen or underscore.") };
  if (existingRoomNames.some((name) => name.toLowerCase() === stripped)) {
    return { ok: false, error: getError("createRoom.duplicate", "A room with this name already exists.") };
  }
  return { ok: true, name: stripped };
}

interface CreateRoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (draft: RoomDraft) => void | Promise<void>;
  projectId?: string;
  existingRoomNames?: string[];
}

export function CreateRoomModal({ isOpen, onClose, onCreate, projectId, existingRoomNames = [] }: CreateRoomModalProps) {
  const { t } = useTranslation("app");
  const [rawName, setRawName] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [search, setSearch] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLoadingAgents(true);
    setSubmitError(null);
    fetchAgents(undefined, projectId)
      .then((result) => setAgents(result))
      .catch(() => {
        setAgents([]);
        setSubmitError(t("createRoom.failedLoadAgents", "Failed to load agents."));
      })
      .finally(() => setLoadingAgents(false));
  }, [isOpen, projectId]);

  useEffect(() => {
    if (!isOpen) {
      setRawName("");
      setSearch("");
      setSelectedAgentIds([]);
      setSubmitError(null);
      setIsSubmitting(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) return;
    previousFocusRef.current?.focus();
  }, [isOpen]);

  const validation = useMemo(() => validateRoomName(rawName, existingRoomNames, t), [rawName, existingRoomNames, t]);

  const filteredAgents = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return agents;
    return agents.filter((agent) => agent.name.toLowerCase().includes(normalized));
  }, [agents, search]);

  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedAgentIds.includes(agent.id)),
    [agents, selectedAgentIds],
  );

  const canSubmit = validation.ok && selectedAgentIds.length > 0 && !isSubmitting && !loadingAgents;

  if (!isOpen) return null;

  const toggleAgent = (id: string) => {
    if (isSubmitting) return;
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((current) => current !== id) : [...prev, id]));
  };

  const handleSubmit = async () => {
    if (!validation.ok) {
      setSubmitError(validation.error);
      return;
    }
    if (selectedAgentIds.length === 0) {
      setSubmitError(t("createRoom.selectMember", "Select at least one member."));
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onCreate({
        name: validation.name,
        displayName: `#${validation.name}`,
        memberAgentIds: selectedAgentIds,
      });
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("createRoom.failedCreate", "Failed to create room."));
    } finally {
      setIsSubmitting(false);
    }
  };

  return createPortal(
    <div className="modal-overlay open" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal modal-lg create-room-modal" role="dialog" aria-modal="true" aria-label={t("createRoom.title", "Create room")} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h3>{t("createRoom.title", "Create room")}</h3>
          <button type="button" className="modal-close" aria-label={t("actions.close", "Close")} onClick={onClose}>×</button>
        </div>

        <div className="form-group create-room-modal-name-group">
          <label htmlFor="create-room-name">{t("createRoom.nameLabel", "Room name")}</label>
          <div className="create-room-modal-name-field">
            <span aria-hidden="true" className="create-room-modal-name-hash">#</span>
            <input
              ref={nameInputRef}
              id="create-room-name"
              className="input"
              value={rawName}
              disabled={isSubmitting}
              onChange={(event) => {
                const normalized = event.target.value.replace(/^#/, "").replace(/\s+/g, "-").toLowerCase();
                setRawName(normalized);
              }}
            />
          </div>
          {!validation.ok && <div className="form-error">{validation.error}</div>}
        </div>

        <div className="form-group">
          <label htmlFor="create-room-member-search">{t("createRoom.members", "Members")}</label>
          <input
            id="create-room-member-search"
            className="input"
            placeholder={t("createRoom.searchAgents", "Search agents")}
            value={search}
            disabled={isSubmitting}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {selectedAgents.length > 0 && (
          <div className="create-room-modal-selected" data-testid="create-room-selected-chips">
            {selectedAgents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="btn btn-sm create-room-modal-chip"
                onClick={() => toggleAgent(agent.id)}
                disabled={isSubmitting}
              >
                {agent.name} ×
              </button>
            ))}
          </div>
        )}

        <div className="create-room-modal-member-list" data-testid="create-room-member-list">
          {loadingAgents ? (
            <div className="create-room-modal-empty"><LoadingSpinner label={t("createRoom.loadingAgents", "Loading agents...")} /></div>
          ) : filteredAgents.length === 0 ? (
            <div className="create-room-modal-empty">
              {agents.length === 0 ? t("createRoom.noAgents", "No agents in this project yet.") : t("createRoom.noMatch", "No agents match your search.")}
            </div>
          ) : (
            filteredAgents.map((agent) => {
              const selected = selectedAgentIds.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`create-room-modal-member-row${selected ? " create-room-modal-member-row--selected" : ""}`}
                  onClick={() => toggleAgent(agent.id)}
                  disabled={isSubmitting}
                >
                  <AgentAvatar agent={agent} size={20} />
                  <span>{agent.name}</span>
                  <span className="create-room-modal-member-role">{agent.role}</span>
                </button>
              );
            })
          )}
        </div>

        {submitError && <div className="form-group"><div className="form-error">{submitError}</div></div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={isSubmitting}>{t("actions.cancel", "Cancel")}</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSubmitting ? t("createRoom.creating", "Creating...") : t("createRoom.create", "Create room")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
