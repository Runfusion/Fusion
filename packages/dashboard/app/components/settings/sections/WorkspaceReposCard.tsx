import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addWorkspaceRepo, fetchWorkspaceRepos } from "../../../api/agents/agents";
import "./WorkspaceReposCard.css";

/*
FNXC:Workspace 2026-08-20-02:03:
Workspace membership is editable after registration; the workspace mode toggle enables the mode but
never adds members. This single module-scope card avoids remounting the free-text input during refresh.
*/
export function WorkspaceReposCard({ projectId }: { projectId?: string }) {
  const { t } = useTranslation("app");
  const [repos, setRepos] = useState<string[] | null>(null);
  const [available, setAvailable] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    try {
      const result = await fetchWorkspaceRepos(projectId, { includeAvailable: true });
      setRepos(result.repos);
      setAvailable(result.available ?? []);
    } catch { setRepos(null); }
  };
  useEffect(() => { void load(); }, [projectId]);
  if (repos === null) return null;
  const add = async () => {
    if (!value.trim()) return;
    setError(null);
    try {
      const result = await addWorkspaceRepo(value.trim(), projectId);
      setRepos(result.repos);
      setAvailable((items) => items.filter((item) => item !== value.trim()));
      setValue("");
    } catch (caught) { setError(caught instanceof Error ? caught.message : t("settings.general.workspaceReposError", "Could not add repository.")); }
  };
  return <section className="workspace-repos-card card" data-testid="workspace-repos-card">
    <h3>{t("settings.general.workspaceRepos", "Workspace repositories")}</h3>
    <ul>{repos.map((repo) => <li key={repo}>{repo}</li>)}</ul>
    <div className="workspace-repos-card__controls">
      <input className="input" list="workspace-repo-candidates" value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("settings.general.workspaceReposPlaceholder", "Repository directory")} />
      <datalist id="workspace-repo-candidates">{available.map((repo) => <option key={repo} value={repo} />)}</datalist>
      <button type="button" className="btn" data-testid="workspace-repo-add-button" onClick={() => void add()}>{t("settings.general.workspaceReposAdd", "Add")}</button>
    </div>
    {error && <p className="workspace-repos-card__error" role="alert">{error}</p>}
  </section>;
}
