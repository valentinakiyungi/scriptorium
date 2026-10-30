import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, settings } from "./config.ts";
import { DOC_TYPES } from "./doctypes.ts";
import { createLLM } from "./llm/index.ts";
import { defaultRequest, runScriptorium, type RunEvent, type RunResult } from "./run.ts";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

interface LiveRun {
  id: string;
  events: RunEvent[];
  listeners: Set<http.ServerResponse>;
  done: boolean;
  result?: RunResult;
}

export async function startServer(opts: { port: number; mock?: boolean }): Promise<http.Server> {
  loadEnv();
  const runs = new Map<string, LiveRun>();
  let counter = 0;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<any>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 1e6) reject(new Error("Body too large"));
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    try {
      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(fs.readFileSync(path.join(PUBLIC, "index.html")));
      }

      if (req.method === "GET" && p === "/api/config") {
        const cfg = settings();
        return json(res, 200, {
          docTypes: DOC_TYPES.map((d) => ({ id: d.id, label: d.label, description: d.description, defaultAudience: d.defaultAudience, sections: d.sections.map((s) => s.heading) })),
          model: opts.mock ? "mock" : cfg.model,
          ready: opts.mock || !!cfg.apiKey,
        });
      }

      if (req.method === "POST" && p === "/api/runs") {
        const body = await readBody(req);
        if (!body.topic || typeof body.topic !== "string") return json(res, 400, { error: "topic is required" });
        if (!DOC_TYPES.some((d) => d.id === body.docType)) return json(res, 400, { error: "unknown docType" });
        let llm;
        try {
          llm = createLLM({ mock: opts.mock || body.mock === true });
        } catch (e: any) {
          return json(res, 400, { error: e.message });
        }
        const request = defaultRequest({
          topic: body.topic.slice(0, 500),
          docType: body.docType,
          audience: body.audience?.slice(0, 200) || undefined,
          instructions: body.instructions?.slice(0, 2000) || undefined,
          maxQuestions: clamp(Number(body.maxQuestions) || 8, 1, 20),
          maxRevisions: clamp(Number(body.maxRevisions ?? 1), 0, 3),
          web: body.web !== false,
        });
        const id = `run${++counter}-${Date.now().toString(36)}`;
        const live: LiveRun = { id, events: [], listeners: new Set(), done: false };
        runs.set(id, live);
        const push = (e: RunEvent) => {
          live.events.push(e);
          for (const l of live.listeners) l.write(`data: ${JSON.stringify(e)}\n\n`);
        };
        runScriptorium(request, { llm, onEvent: push })
          .then((r) => (live.result = r))
          .catch((e) => push({ type: "error", message: e?.message ?? String(e) }))
          .finally(() => {
            live.done = true;
            for (const l of live.listeners) l.end();
            live.listeners.clear();
          });
        return json(res, 202, { id });
      }

      const evMatch = p.match(/^\/api\/runs\/([\w-]+)\/events$/);
      if (req.method === "GET" && evMatch) {
        const live = runs.get(evMatch[1]);
        if (!live) return json(res, 404, { error: "run not found" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const e of live.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (live.done) return res.end();
        live.listeners.add(res);
        req.on("close", () => live.listeners.delete(res));
        return;
      }

      const docMatch = p.match(/^\/api\/runs\/([\w-]+)\/(document\.md|run\.json)$/);
      if (req.method === "GET" && docMatch) {
        const r = runs.get(docMatch[1])?.result;
        if (!r) return json(res, 404, { error: "document not ready" });
        const file = slugName(r.title);
        if (docMatch[2] === "document.md") {
          res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${file}.md"` });
          return res.end(r.markdown);
        }
        return json(res, 200, r);
      }

      if (req.method === "GET" && p === "/api/history") {
        const dir = settings().outputDir;
        const items = fs.existsSync(dir)
          ? fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "run.json")))
              .map((d) => {
                const r = JSON.parse(fs.readFileSync(path.join(dir, d.name, "run.json"), "utf8"));
                return { id: d.name, title: r.title, docType: r.docType, score: r.metrics?.finalScore, words: r.metrics?.words };
              })
              .sort((a, b) => b.id.localeCompare(a.id))
              .slice(0, 30)
          : [];
        return json(res, 200, items);
      }

      const histMatch = p.match(/^\/api\/history\/([\w.-]+)$/);
      if (req.method === "GET" && histMatch) {
        const f = path.join(settings().outputDir, histMatch[1], "document.md");
        if (!fs.existsSync(f)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
        return res.end(fs.readFileSync(f));
      }

      json(res, 404, { error: "not found" });
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  console.log(`\n✒  Scriptorium is running at http://localhost:${port}${opts.mock ? "  (mock mode)" : ""}\n`);
  return server;
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function slugName(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
}
