import { Router, type Request, type Response } from "express";
import type { TaskStore } from "@fusion/core";
import {
  applyAutostashBySha,
  dropAutostashBySha,
  getAutostashDiff,
  listAutostashOrphans,
  notifyAutostashOrphans,
} from "@fusion/engine";
import { badRequest } from "../api-error.js";

const SHA_RE = /^[0-9a-f]{7,40}$/;

function validateSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

function getRootDir(store: TaskStore): string {
  return store.getRootDir();
}

export function createStashRecoveryRouter(store: TaskStore): Router {
  const router = Router();

  router.get("/orphans", async (_req: Request, res: Response) => {
    const rootDir = getRootDir(store);
    const records = await listAutostashOrphans(rootDir);
    res.json({ count: records.length, records, rootDir });
  });

  router.get("/orphans/:sha/diff", async (req: Request, res: Response) => {
    const sha = String(req.params.sha ?? "").trim();
    if (!validateSha(sha)) throw badRequest("Invalid stash sha");
    const rootDir = getRootDir(store);
    const diff = await getAutostashDiff(rootDir, sha);
    const truncated = diff.includes("… (diff truncated)");
    res.json({ sha, diff, truncated });
  });

  router.post("/orphans/:sha/apply", async (req: Request, res: Response) => {
    const sha = String(req.params.sha ?? "").trim();
    if (!validateSha(sha)) throw badRequest("Invalid stash sha");
    const rootDir = getRootDir(store);
    const result = await applyAutostashBySha(rootDir, sha);
    res.status(200).json(result);
  });

  router.post("/orphans/:sha/drop", async (req: Request, res: Response) => {
    const sha = String(req.params.sha ?? "").trim();
    if (!validateSha(sha)) throw badRequest("Invalid stash sha");
    if (req.body?.confirm !== true) throw badRequest("confirm: true is required");
    const rootDir = getRootDir(store);
    const result = await dropAutostashBySha(rootDir, "stash-recovery", sha);
    if (!result.dropped) {
      res.status(200).json({ ok: false, reason: result.reason ?? "drop_failed" });
      return;
    }
    res.status(200).json({ ok: true });
  });

  router.post("/refresh", async (_req: Request, res: Response) => {
    const rootDir = getRootDir(store);
    const records = await notifyAutostashOrphans(store, rootDir);
    res.json({ count: records.length, records, rootDir });
  });

  return router;
}
