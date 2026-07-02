import { Router, type Request } from "express";
import type { BranchGroup, Task, TaskStore } from "@fusion/core";
import { isBranchGroupComplete, isBranchGroupMemberLanded, filterTasksByBranchGroup } from "@fusion/core";
import { badRequest, notFound } from "../api-error.js";

export interface BranchGroupsRouterOptions {
  promoteBranchGroup?: (input: { groupId: string; projectId?: string }) => Promise<Record<string, unknown>>;
  /**
   * Terminal reconciliation when a group is abandoned (U6, R7): best-effort
   * close the single managed GitHub PR. Returns the reconciled prState so the
   * route can persist it. Injected so the router does not hard-depend on a
   * GitHub client being available; when omitted, abandon still marks the row
   * `abandoned`/`closed` without touching GitHub.
   */
  closeGroupPr?: (input: {
    group: BranchGroup;
    projectId?: string;
  }) => Promise<{ prNumber: number; prUrl: string; prState: BranchGroup["prState"] } | null>;
  /**
   * Out-of-band PR reconciliation on single-group read (Fix #3): when a group has
   * an open managed PR, this is invoked best-effort before serialization so a PR
   * merged/closed directly on GitHub flips `prState` accordingly. Wired over the
   * engine's `reconcileBranchGroupPr` + a GitHub-backed `SyncGroupPrFn`. Omitted
   * (or throwing) leaves the persisted state untouched. Only the single-group
   * GET path calls this — the list stays cheap.
   */
  reconcileGroupPr?: (input: {
    group: BranchGroup;
    projectId?: string;
  }) => Promise<BranchGroup>;
}

function parseProjectId(req: Request): string | undefined {
  const value = req.query.projectId ?? req.body?.projectId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Serialize a single group. Pass `allTasks` to filter membership in memory from a
 * single up-front `listTasks` call (list route, Fix #8/#9 — avoids the N+1 scan);
 * omit it to fall back to a per-group `listTasksByBranchGroup` scan (single-group
 * read / abandon, where one scan is fine).
 */
async function serializeGroup(store: TaskStore, group: BranchGroup, allTasks?: Task[]) {
  const members = allTasks
    ? filterTasksByBranchGroup(allTasks, group, group.id).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
    : await store.listTasksByBranchGroup(group.id);
  const memberRows = members.map((task) => ({
    taskId: task.id,
    title: task.title ?? task.description,
    column: task.column,
    landed: isBranchGroupMemberLanded(task, group),
  }));
  const landedCount = memberRows.filter((member) => member.landed).length;
  return {
    ...group,
    members: memberRows,
    completion: {
      landed: landedCount,
      total: memberRows.length,
      complete: isBranchGroupComplete(members, group),
    },
  };
}

export function createBranchGroupsRouter(store: TaskStore, options?: BranchGroupsRouterOptions): Router {
  const router = Router();

  router.get("/", async (req, res) => {
    const statusRaw = req.query.status;
    const status = typeof statusRaw === "string" && statusRaw.trim() ? statusRaw.trim() : undefined;
    if (status && status !== "open" && status !== "finalized" && status !== "abandoned") {
      throw badRequest("status must be one of: open, finalized, abandoned");
    }

    const groups = await store.listBranchGroups(status ? { status: status as BranchGroup["status"] } : undefined);
    // Fix #8/#9: fetch tasks ONCE and filter per group in memory rather than one
    // full scan per group (the old N+1). Membership semantics (incl. legacy
    // synthetic-groupId fallback) come from the shared `filterTasksByBranchGroup`.
    const allTasks = await store.listTasks({ includeArchived: false, slim: true });
    const data = await Promise.all(groups.map((group) => serializeGroup(store, group, allTasks)));
    res.json({ groups: data });
  });

  router.get("/:id", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    let group = await store.getBranchGroup(id);
    if (!group) throw notFound("Branch group not found");

    // Fix #3: reconcile an out-of-band merged/closed PR before serializing so the
    // response reflects the real GitHub state. Best-effort — a reconcile failure
    // must not break the read; we serialize the (possibly stale) persisted state.
    if (group.prNumber != null && group.prState === "open" && options?.reconcileGroupPr) {
      try {
        group = await options.reconcileGroupPr({ group, projectId: parseProjectId(req) });
      } catch {
        group = (await store.getBranchGroup(id)) ?? group;
      }
    }

    res.json({ group: await serializeGroup(store, group) });
  });

  router.post("/assign", async (req, res) => {
    const taskId = typeof req.body?.taskId === "string" ? req.body.taskId.trim() : "";
    if (!taskId) throw badRequest("taskId is required");

    const task = await store.getTask(taskId);
    const groupIdBody = req.body?.groupId;
    const branchNameRaw = req.body?.branchName;
    const branchName = typeof branchNameRaw === "string" && branchNameRaw.trim() ? branchNameRaw.trim() : undefined;

    if (groupIdBody === null) {
      await store.setTaskBranchGroup(taskId, null);
      res.json({ taskId, groupId: null });
      return;
    }

    let groupId = typeof groupIdBody === "string" && groupIdBody.trim() ? groupIdBody.trim() : undefined;
    if (!groupId) {
      if (!branchName) throw badRequest("branchName is required when groupId is not provided");
      const sourceType = task.branchContext?.source ?? "planning";
      const sourceId = `task:${task.id}`;
      const created = await store.ensureBranchGroupForSource(sourceType, sourceId, {
        branchName,
        autoMerge: task.autoMerge ?? false,
      });
      groupId = created.id;
    } else if (!(await store.getBranchGroup(groupId))) {
      throw notFound("Branch group not found");
    }

    await store.setTaskBranchGroup(taskId, groupId);
    res.json({ taskId, groupId });
  });

  router.post("/:id/promote", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const group = await store.getBranchGroup(id);
    if (!group) throw notFound("Branch group not found");

    const members = await store.listTasksByBranchGroup(group.id);
    if (!isBranchGroupComplete(members, group)) {
      throw badRequest("Branch group completion gate not satisfied");
    }

    const promote = options?.promoteBranchGroup;
    if (!promote) {
      throw badRequest("Branch-group promotion is unavailable");
    }

    const result = await promote({ groupId: id, projectId: parseProjectId(req) });
    res.json({ groupId: id, ...result });
  });

  // Terminal reconciliation: abandon a group. Best-effort closes the single
  // managed GitHub PR (U6, R7), then marks the row `abandoned` with prState
  // `closed`. The PR close is best-effort: if it fails or no closeGroupPr is
  // wired, the row is still marked abandoned/closed (the GitHub PR is left for
  // out-of-band reconciliation on the next read/sync).
  router.post("/:id/abandon", async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) throw badRequest("id is required");
    const group = await store.getBranchGroup(id);
    if (!group) throw notFound("Branch group not found");

    // Fix #2: a finalized, already-abandoned, or already-merged group is terminal
    // and must not be flipped to abandoned/closed (mirrors the promote route's gate
    // style). The CLI's runBranchGroupAbandon also guards the abandoned status, so
    // re-abandoning a `prState: "none"` group can't silently persist `prState: "closed"`.
    if (group.status === "abandoned" || group.status === "finalized" || group.prState === "merged") {
      throw badRequest("Branch group is already abandoned, finalized, or merged and cannot be abandoned");
    }

    // The guard above already rejected `prState === "merged"`. A group with a PR
    // abandons to "closed" (unless the GitHub reconcile below reports otherwise);
    // a group that never had a PR keeps its existing prState — "closed" would
    // falsely imply a PR existed and was closed when none ever did.
    let prState: BranchGroup["prState"] = group.prNumber != null ? "closed" : group.prState;
    let prNumber = group.prNumber;
    let prUrl = group.prUrl;

    if (group.prNumber != null && group.prState === "open" && options?.closeGroupPr) {
      try {
        const reconciled = await options.closeGroupPr({ group, projectId: parseProjectId(req) });
        if (reconciled) {
          prState = reconciled.prState;
          prNumber = reconciled.prNumber;
          prUrl = reconciled.prUrl;
        }
      } catch {
        // Best-effort: leave the GitHub PR for out-of-band reconciliation.
      }
    }

    const updated = await store.updateBranchGroup(id, {
      status: "abandoned",
      prState,
      prNumber: prNumber ?? null,
      prUrl: prUrl ?? null,
    });
    res.json({ groupId: id, group: await serializeGroup(store, updated) });
  });

  return router;
}
