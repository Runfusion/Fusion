---
"@runfusion/fusion": minor
---

summary: Project creation warns when Git is missing, with install or create-anyway options.
category: feature
dev: "SetupWizardModal probes gitCli before registering and shows a three-way ConfirmDialog (create anyway / open downloads / cancel; clone mode offers install-only). New skipGitInit passthrough: ProjectCreateInput → POST /api/projects (rejected for clone mode) → EnsureProjectForPathInput → ensureProjectForPath skips ensureGitRepositoryForProjectPath."
