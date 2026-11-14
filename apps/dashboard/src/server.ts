#!/usr/bin/env node
/**
 * AgentReplay dashboard — local, read-only viewer for recorded runs.
 *
 *   node --conditions=development apps/dashboard/src/server.ts [--dir .agent-replay] [--port 4317]
 *
 * API
 *   GET /api/runs                     run metadata, newest first
 *   GET /api/runs/:runId              { meta, events }
 *   GET /api/blobs/:sha256            raw payload JSON
 *   GET /api/diff?a=&b=[&tools=1]     first divergence between two runs
 */
import { createServer, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStore, firstDivergence } from "agentreplay";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const dir = resolve(opt("dir", ".agent-replay"));
const port = Number(opt("port", "4317"));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

if (!existsSync(dir)) {
  console.error(`No trace store at ${dir}. Record a run first, or pass --dir <path>.`);
  process.exit(1);
}
const store = new FileStore(dir);

const RUN_ID = /^[\w-]{1,64}$/;
const BLOB = /^[a-f0-9]{64}$/;
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
};
const MIME: Record<string, string> = { html: "text/html", js: "text/javascript", css: "text/css" };

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  try {
    if (STATIC[path]) {
      const file = STATIC[path];
      return send(res, 200, readFileSync(join(publicDir, file), "utf8"), MIME[file.split(".").pop()!]);
    }
    if (path === "/api/runs") {
      return send(res, 200, { dir, runs: store.listRuns().reverse() });
    }
    let m = path.match(/^\/api\/runs\/([^/]+)$/);
    if (m) {
      if (!RUN_ID.test(m[1])) return send(res, 400, { error: "bad run id" });
      return send(res, 200, { meta: store.readMeta(m[1]), events: store.readEvents(m[1]) });
    }
    m = path.match(/^\/api\/blobs\/([^/]+)$/);
    if (m) {
      if (!BLOB.test(m[1])) return send(res, 400, { error: "bad blob hash" });
      return send(res, 200, store.getBlob(m[1]));
    }
    if (path === "/api/diff") {
      const a = url.searchParams.get("a") ?? "";
      const b = url.searchParams.get("b") ?? "";
      if (!RUN_ID.test(a) || !RUN_ID.test(b)) return send(res, 400, { error: "bad run ids" });
      return send(res, 200, { divergence: firstDivergence(store, a, b, { toolsOnly: url.searchParams.get("tools") === "1" }) });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`AgentReplay dashboard → http://localhost:${port}  (store: ${dir})`);
});
