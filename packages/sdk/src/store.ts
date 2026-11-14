import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./hash.ts";
import type { BlobRef, RunMeta, TraceEvent } from "./schema.ts";

/**
 * v0 storage: plain files, zero dependencies.
 *
 *   .agent-replay/
 *     blobs/<sha256>.json          content-addressed, shared across runs
 *     runs/<runId>/meta.json
 *     runs/<runId>/events.jsonl    append-only
 *
 * Swap for SQLite (node:sqlite) once querying across runs matters.
 */
export class FileStore {
  readonly root: string;

  constructor(root = ".agent-replay") {
    this.root = root;
    mkdirSync(join(root, "blobs"), { recursive: true });
    mkdirSync(join(root, "runs"), { recursive: true });
  }

  /**
   * Stores the EXACT serialization (original key order). Replay must hand the
   * agent byte-identical payloads — a canonicalized copy re-stringifies
   * differently and makes every downstream request hash diverge.
   * Request *matching* uses canonical hashing separately (see hashValue).
   */
  putBlob(value: unknown): BlobRef {
    const text = JSON.stringify(value ?? null);
    const blob = sha256(text);
    const path = join(this.root, "blobs", `${blob}.json`);
    if (!existsSync(path)) writeFileSync(path, text);
    return { blob, bytes: Buffer.byteLength(text) };
  }

  getBlob<T = unknown>(ref: BlobRef | string): T {
    const hash = typeof ref === "string" ? ref : ref.blob;
    return JSON.parse(readFileSync(join(this.root, "blobs", `${hash}.json`), "utf8"));
  }

  private runDir(runId: string): string {
    return join(this.root, "runs", runId);
  }

  writeMeta(meta: RunMeta): void {
    mkdirSync(this.runDir(meta.runId), { recursive: true });
    writeFileSync(join(this.runDir(meta.runId), "meta.json"), JSON.stringify(meta, null, 2));
  }

  readMeta(runId: string): RunMeta {
    return JSON.parse(readFileSync(join(this.runDir(runId), "meta.json"), "utf8"));
  }

  appendEvent(event: TraceEvent): void {
    appendFileSync(join(this.runDir(event.runId), "events.jsonl"), JSON.stringify(event) + "\n");
  }

  readEvents(runId: string): TraceEvent[] {
    const path = join(this.runDir(runId), "events.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  listRuns(): RunMeta[] {
    return readdirSync(join(this.root, "runs"))
      .filter((id) => existsSync(join(this.runDir(id), "meta.json")))
      .map((id) => this.readMeta(id))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
}
