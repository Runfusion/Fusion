import "./SkillsView.css";
import "./SnippetsView.css";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Pencil, Plus, Trash2, Type } from "lucide-react";
import { ViewHeader } from "./ViewHeader";
import { ViewLayout } from "./ViewLayout";
import { ViewSidebar } from "./ViewSidebar";
import { ViewActionButton } from "./ViewActionButton";
import {
  CHAT_SNIPPET_MAX_ENTRIES,
  CHAT_SNIPPET_MAX_PROMPT_LENGTH,
  CHAT_SNIPPET_RESERVED_NAMES,
  normalizeChatSnippetName,
} from "@fusion/core";
import { useChatSnippetsCache } from "../hooks/useChatSnippetsCache";

/*
FNXC:SnippetsDestination 2026-09-16-21:44:
FN-476: Snippets is a navigation destination, not a window. It therefore takes NO props: an operator leaves it by
navigating, so a close cross is chrome that does not belong, and a manual Refresh button is an admission that the view
can go stale. It stays current on its own — the shared cache is invalidated by a server notification, so a snippet
created, renamed, or deleted elsewhere appears here without a click. The error state keeps its Retry, which is a
recovery action rather than permanent header chrome.
*/

/*
FNXC:SnippetsDestination 2026-09-14-04:12:
Snippets is its OWN destination, no longer the second tab of Skills. The two domains share nothing but a former
container: skills are discovered and toggled per project, snippets are reusable chat prompts edited by hand. As a
standalone view each gets the ordinary collection shape — the saved snippets are the sidebar rail, the editor is the
main panel — instead of a full-width workspace competing with the skills master list for the same screen.

The snippet cache, validation rules, and mutation contracts are unchanged; only their host moved.
*/
export function SnippetsView() {
  const { t } = useTranslation("app");
  const {
    snippets,
    loading: snippetsLoading,
    error: snippetsError,
    hasLoaded: snippetsHaveLoaded,
    createSnippet,
    // `refresh` remains the error-state recovery action only; no permanent header control calls it.
    updateSnippet,
    deleteSnippet,
    refresh: refreshSnippets,
  } = useChatSnippetsCache();
  const [snippetName, setSnippetName] = useState("");
  const [snippetPrompt, setSnippetPrompt] = useState("");
  const [editingSnippetName, setEditingSnippetName] = useState<string | null>(null);
  const [snippetMutationPending, setSnippetMutationPending] = useState<string | null>(null);
  const [snippetFormError, setSnippetFormError] = useState<string | null>(null);

  const resetSnippetForm = useCallback(() => {
    setSnippetName("");
    setSnippetPrompt("");
    setEditingSnippetName(null);
    setSnippetFormError(null);
  }, []);

  const validateSnippetForm = useCallback((): string | null => {
    const candidateName = snippetName.normalize("NFKC").trim().toLowerCase();
    if ((CHAT_SNIPPET_RESERVED_NAMES as readonly string[]).includes(candidateName)) {
      return t("skills.snippetsReservedName", "This name is reserved for a chat command.");
    }
    const normalizedName = normalizeChatSnippetName(snippetName);
    if (!normalizedName) {
      return t("skills.snippetsInvalidName", "Use 1–48 letters, numbers, underscores, or hyphens.");
    }
    if (snippetPrompt.trim().length === 0) {
      return t("skills.snippetsPromptRequired", "Enter a prompt for this snippet.");
    }
    if (snippetPrompt.length > CHAT_SNIPPET_MAX_PROMPT_LENGTH) {
      return t("skills.snippetsPromptTooLong", "Prompts can contain at most {{count}} characters.", { count: CHAT_SNIPPET_MAX_PROMPT_LENGTH });
    }
    const duplicate = snippets.some((snippet) =>
      snippet.name === normalizedName && snippet.name !== editingSnippetName,
    );
    if (duplicate) {
      return t("skills.snippetsDuplicateName", "A snippet with this name already exists.");
    }
    if (!editingSnippetName && snippets.length >= CHAT_SNIPPET_MAX_ENTRIES) {
      return t("skills.snippetsLimitReached", "You can save up to {{count}} snippets.", { count: CHAT_SNIPPET_MAX_ENTRIES });
    }
    return null;
  }, [editingSnippetName, snippetName, snippetPrompt, snippets, t]);

  const handleSnippetSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!snippetsHaveLoaded || snippetMutationPending !== null) return;
    const validationError = validateSnippetForm();
    if (validationError) {
      setSnippetFormError(validationError);
      return;
    }
    const normalizedName = normalizeChatSnippetName(snippetName)!;
    setSnippetFormError(null);
    setSnippetMutationPending(editingSnippetName ?? "create");
    try {
      if (editingSnippetName) {
        await updateSnippet(editingSnippetName, { name: normalizedName, prompt: snippetPrompt });
      } else {
        await createSnippet({ name: normalizedName, prompt: snippetPrompt });
      }
      resetSnippetForm();
    } catch {
      setSnippetFormError(t("skills.snippetsSaveError", "The snippet could not be saved. Try again."));
    } finally {
      setSnippetMutationPending(null);
    }
  }, [createSnippet, editingSnippetName, resetSnippetForm, snippetMutationPending, snippetName, snippetPrompt, snippetsHaveLoaded, t, updateSnippet, validateSnippetForm]);

  const handleEditSnippet = useCallback((name: string) => {
    const snippet = snippets.find((candidate) => candidate.name === name);
    if (!snippet) return;
    setEditingSnippetName(snippet.name);
    setSnippetName(snippet.name);
    setSnippetPrompt(snippet.prompt);
    setSnippetFormError(null);
  }, [snippets]);

  const handleDeleteSnippet = useCallback(async (name: string) => {
    if (!snippetsHaveLoaded || snippetMutationPending !== null) return;
    setSnippetMutationPending(name);
    try {
      await deleteSnippet(name);
      if (editingSnippetName === name) resetSnippetForm();
    } catch {
      setSnippetFormError(t("skills.snippetsDeleteError", "The snippet could not be deleted. Try again."));
    } finally {
      setSnippetMutationPending(null);
    }
  }, [deleteSnippet, editingSnippetName, resetSnippetForm, snippetMutationPending, snippetsHaveLoaded, t]);

  const snippetsHeader = (
    <ViewHeader
      icon={Type}
      title={t("skills.snippetsTitle", "Chat Snippets")}
      actions={
        <>
          <span className="skills-view-snippets__count" data-testid="snippets-count">
            {t("skills.snippetsCount", "{{count}} saved", { count: snippets.length })}
          </span>
          <ViewActionButton
            kind="create"
            label={t("skills.snippetsNew", "New snippet")}
            onClick={resetSnippetForm}
            data-testid="snippets-new"
          />
        </>
      }
    />
  );

  return (
    <ViewLayout
      className="snippets-view"
      data-testid="snippets-view"
      header={snippetsHeader}
      contentOwnsScroll
      sidebar={
        <ViewSidebar
          className="snippets-view__list"
          ariaLabel={t("skills.snippetsListLabel", "Saved snippets")}
          hostIdentity="snippets"
          panelTestId="snippets-list"
        >
          <div className="snippets-view__list-body">
            {snippetsLoading && !snippetsHaveLoaded ? (
              <div className="skills-view-loading" data-testid="snippets-loading">
                <span className="spinner" />
                {t("skills.snippetsLoading", "Loading snippets...")}
              </div>
            ) : null}

            {snippetsError ? (
              <div className="skills-view-error skills-view-snippets__error" role="alert">
                <p>{t("skills.snippetsLoadError", "Snippets could not be refreshed. Your last loaded list is still shown.")}</p>
                <button type="button" className="btn btn-sm" onClick={() => void refreshSnippets()}>
                  {t("common.retry", "Retry")}
                </button>
              </div>
            ) : null}

            {snippetsHaveLoaded && snippets.length === 0 ? (
              <div className="skills-view-empty skills-view-snippets__empty" data-testid="snippets-empty">
                <p>{t("skills.snippetsEmpty", "No snippets saved yet.")}</p>
                <p>{t("skills.snippetsEmptyHint", "Create one here, then type /name in any chat to insert it.")}</p>
              </div>
            ) : snippets.length > 0 ? (
              <div className="skills-view-snippets__list" data-testid="snippets-collection">
                {snippets.map((snippet) => (
                  <article
                    key={snippet.name}
                    className={`skills-view-snippets__item${editingSnippetName === snippet.name ? " skills-view-snippets__item--selected" : ""}`}
                  >
                    {/* Named by its own trigger text: the sibling pencil owns the explicit "Edit /name" label. */}
                    <button
                      type="button"
                      className="skills-view-snippets__item-content"
                      onClick={() => handleEditSnippet(snippet.name)}
                      data-testid={`snippets-item-${snippet.name}`}
                    >
                      <code className="skills-view-snippets__trigger">/{snippet.name}</code>
                      <p className="skills-view-snippets__preview">{snippet.prompt}</p>
                    </button>
                    <div className="skills-view-snippets__item-actions">
                      {snippetMutationPending === snippet.name ? (
                        <span className="skills-view-snippets__pending">
                          <Loader2 size={14} className="spin" />
                          {t("skills.snippetsSaving", "Saving...")}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="btn-icon touch-target"
                        onClick={() => handleEditSnippet(snippet.name)}
                        disabled={!snippetsHaveLoaded || snippetMutationPending !== null}
                        aria-label={t("skills.snippetsEdit", "Edit /{{name}}", { name: snippet.name })}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon touch-target"
                        onClick={() => void handleDeleteSnippet(snippet.name)}
                        disabled={!snippetsHaveLoaded || snippetMutationPending !== null}
                        aria-label={t("skills.snippetsDelete", "Delete /{{name}}", { name: snippet.name })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </div>
        </ViewSidebar>
      }
    >
      <section className="snippets-view__editor" aria-labelledby="chat-snippets-editor-title">
        <div className="skills-view-section-title">
          <h3 id="chat-snippets-editor-title">
            {editingSnippetName
              ? t("skills.snippetsEditing", "Editing /{{name}}", { name: editingSnippetName })
              : t("skills.snippetsAdd", "Add snippet")}
          </h3>
        </div>

        <p className="skills-view-snippets__description">
          {t("skills.snippetsDescription", "Save reusable prompts, then type /name in any chat to insert one without sending it.")}
        </p>

        <form className="skills-view-snippets__form" onSubmit={handleSnippetSubmit} aria-label={t("skills.snippetsFormLabel", "Chat snippet editor")}>
          <label className="skills-view-snippets__field">
            <span>{t("skills.snippetsNameLabel", "Name")}</span>
            <div className="skills-view-snippets__name-input">
              <span aria-hidden="true">/</span>
              <input
                type="text"
                className="form-input"
                value={snippetName}
                onChange={(event) => {
                  setSnippetName(event.target.value);
                  setSnippetFormError(null);
                }}
                autoComplete="off"
                aria-label={t("skills.snippetsNameLabel", "Name")}
                aria-describedby="chat-snippet-name-help"
              />
            </div>
            <span id="chat-snippet-name-help" className="skills-view-snippets__help">
              {t("skills.snippetsNameHelp", "Letters, numbers, underscores, or hyphens; up to 48 characters.")}
            </span>
          </label>
          <label className="skills-view-snippets__field">
            <span>{t("skills.snippetsPromptLabel", "Prompt")}</span>
            <textarea
              className="form-input skills-view-snippets__prompt"
              value={snippetPrompt}
              aria-label={t("skills.snippetsPromptLabel", "Prompt")}
              onChange={(event) => {
                setSnippetPrompt(event.target.value);
                setSnippetFormError(null);
              }}
              rows={4}
            />
            <span className="skills-view-snippets__help">
              {t("skills.snippetsPromptHelp", "{{count}} / {{max}} characters", { count: snippetPrompt.length, max: CHAT_SNIPPET_MAX_PROMPT_LENGTH })}
            </span>
          </label>
          {snippetFormError ? <p className="skills-view-snippets__form-error" role="alert">{snippetFormError}</p> : null}
          <div className="skills-view-snippets__form-actions">
            <button
              type="submit"
              className="btn btn-sm"
              disabled={!snippetsHaveLoaded || snippetMutationPending !== null}
            >
              {snippetMutationPending === (editingSnippetName ?? "create") ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
              {snippetMutationPending === (editingSnippetName ?? "create")
                ? t("skills.snippetsSaving", "Saving...")
                : editingSnippetName
                  ? t("skills.snippetsSaveChanges", "Save changes")
                  : t("skills.snippetsAdd", "Add snippet")}
            </button>
            {editingSnippetName ? (
              <button type="button" className="btn btn-sm" onClick={resetSnippetForm} disabled={snippetMutationPending !== null}>
                {t("common.cancel", "Cancel")}
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </ViewLayout>
  );
}
