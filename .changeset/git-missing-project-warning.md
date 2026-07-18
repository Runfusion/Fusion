---
"@runfusion/fusion": minor
---

summary: Project creation now warns up front when Git is missing, with the choice to open the Git downloads or create the project without a git repo.
category: feature
dev: "SetupWizardModal probes gitCli before registering and shows a three-way ConfirmDialog (create anyway / open downloads / cancel; clone mode offers install-only). New skipGitInit passthrough: ProjectCreateInput → POST /api/projects (rejected for clone mode) → EnsureProjectForPathInput → ensureProjectForPath skips ensureGitRepositoryForProjectPath."
