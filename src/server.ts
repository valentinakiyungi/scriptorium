import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, saveEnv, settings } from "./config.ts";
import { DOC_TYPES } from "./doctypes.ts";
import { createLLM } from "./llm/index.ts";
import { defaultRequest, runScriptorium, type ReferenceDoc, type RunEvent, type RunResult } from "./run.ts";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_REF_CHARS = 400_000;

interface LiveRun {
  id: string;
  events: RunEvent[];
  listeners: Set<http.ServerResponse>;
  done: boolean;
  abort: AbortController;
  result?: RunResult;
}

export async function startServer(opts: { port: number; mock?: boolean; host?: string }): Promise<http.Server> {
  loadEnv();
  const runs = new Map<string, LiveRun>();
  let counter = 0;

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: http.IncomingMessage, limit = 2_000_000) =>
    new Promise<any>((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > limit) reject(new Error("Request body too large"));
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
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
        return res.end(fs.readFileSync(path.join(PUBLIC, "index.html")));
      }

      if (req.method === "GET" && p === "/api/config") {
        const cfg = settings();
        return json(res, 200, {
          docTypes: DOC_TYPES.map((d) => ({
            id: d.id,
            label: d.label,
            description: d.description,
            defaultAudience: d.defaultAudience,
            examples: d.examples,
            targetWords: d.targetWords,
            sections: d.sections.map((s) => s.heading),
          })),
          model: opts.mock ? "mock" : cfg.model,
          mock: !!opts.mock,
          ready: opts.mock || !!cfg.apiKey,
        });
      }

      // ── Settings (key setup from the UI) ────────────────────────────────────
      if (req.method === "GET" && p === "/api/settings") {
        const cfg = settings();
        return json(res, 200, {
          hasKey: !!cfg.apiKey,
          keyHint: cfg.apiKey ? `…${cfg.apiKey.slice(-4)}` : "",
          model: cfg.model,
          researchModel: process.env.GEMINI_RESEARCH_MODEL || "",
          passScore: cfg.passScore,
          concurrency: cfg.concurrency,
        });
      }

      if (req.method === "POST" && p === "/api/settings") {
        const b = await readBody(req);
        const updates: Record<string, string> = {};
        if (typeof b.apiKey === "string" && b.apiKey.trim()) updates.GEMINI_API_KEY = b.apiKey.trim();
        if (typeof b.model === "string" && /^[\w.\-]+$/.test(b.model)) updates.GEMINI_MODEL = b.model;
        if (typeof b.researchModel === "string" && /^[\w.\-]*$/.test(b.researchModel)) updates.GEMINI_RESEARCH_MODEL = b.researchModel;
        if (Number.isFinite(+b.passScore)) updates.SCRIPTORIUM_PASS_SCORE = String(Math.max(1, Math.min(10, Math.round(+b.passScore))));
        if (Number.isFinite(+b.concurrency)) updates.SCRIPTORIUM_CONCURRENCY = String(Math.max(1, Math.min(16, Math.round(+b.concurrency))));
        saveEnv(updates);
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && p === "/api/settings/test") {
        const b = await readBody(req);
        const key = (typeof b.apiKey === "string" && b.apiKey.trim()) || settings().apiKey;
        const model = (typeof b.model === "string" && b.model) || settings().model;
        if (!key) return json(res, 200, { ok: false, message: "No API key entered." });
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
            headers: { "x-goog-api-key": key },
            signal: AbortSignal.timeout(10_000),
          });
          const d: any = await r.json().catch(() => ({}));
          return json(res, 200, r.ok ? { ok: true, message: `Connected — ${d.displayName ?? model} is available.` } : { ok: false, message: d?.error?.message ?? `HTTP ${r.status}` });
        } catch (e: any) {
          return json(res, 200, { ok: false, message: `Could not reach Gemini: ${e?.message ?? e}` });
        }
      }

      // ── Reference sources: fetch a URL into plain text ─────────────────────
      if (req.method === "POST" && p === "/api/fetch-url") {
        const b = await readBody(req);
        let target: URL;
        try {
          target = new URL(String(b.url));
          if (!/^https?:$/.test(target.protocol)) throw new Error();
        } catch {
          return json(res, 400, { error: "Enter a valid http(s) URL." });
        }
        try {
          const r = await fetch(target, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": "Scriptorium/1.0 (+research assistant)" } });
          if (!r.ok) return json(res, 400, { error: `The page returned HTTP ${r.status}.` });
          const raw = (await r.text()).slice(0, 3_000_000);
          const { title, text } = htmlToText(raw);
          if (text.length < 200) return json(res, 400, { error: "Couldn't extract readable text from that page." });
          return json(res, 200, { name: title || target.hostname, url: r.url || target.href, text: text.slice(0, MAX_REF_CHARS) });
        } catch (e: any) {
          return json(res, 400, { error: `Couldn't fetch the page: ${e?.message ?? e}` });
        }
      }

      // ── Runs ───────────────────────────────────────────────────────────────
      if (req.method === "POST" && p === "/api/runs") {
        const body = await readBody(req, 6_000_000);
        if (!body.topic || typeof body.topic !== "string") return json(res, 400, { error: "Tell Scriptorium what to write about." });
        if (!DOC_TYPES.some((d) => d.id === body.docType)) return json(res, 400, { error: "Unknown document type." });
        let llm;
        try {
          llm = createLLM({ mock: opts.mock || body.mock === true });
        } catch (e: any) {
          return json(res, 400, { error: e.message, code: "NO_KEY" });
        }
        const references: ReferenceDoc[] = (Array.isArray(body.references) ? body.references : [])
          .slice(0, 20)
          .filter((r: any) => typeof r?.text === "string" && r.text.trim())
          .map((r: any) => ({ name: String(r.name || "Reference").slice(0, 120), text: r.text.slice(0, MAX_REF_CHARS), url: typeof r.url === "string" && /^https?:/.test(r.url) ? r.url : undefined }));
        const request = defaultRequest({
          topic: body.topic.slice(0, 1000),
          docType: body.docType,
          audience: body.audience?.slice(0, 200) || undefined,
          instructions: body.instructions?.slice(0, 2000) || undefined,
          maxQuestions: clamp(Number(body.maxQuestions) || 8, 1, 20),
          maxRevisions: clamp(Number(body.maxRevisions ?? 1), 0, 3),
          web: body.web !== false,
        });
        const id = `run${++counter}-${Date.now().toString(36)}`;
        const live: LiveRun = { id, events: [], listeners: new Set(), done: false, abort: new AbortController() };
        runs.set(id, live);
        const push = (e: RunEvent) => {
          live.events.push(e);
          for (const l of live.listeners) l.write(`data: ${JSON.stringify(e)}\n\n`);
        };
        runScriptorium(request, { llm, onEvent: push, references, signal: live.abort.signal })
          .then((r) => (live.result = r))
          .catch((e) => push({ type: "error", message: live.abort.signal.aborted ? "Run stopped." : (e?.message ?? String(e)) }))
          .finally(() => {
            live.done = true;
            for (const l of live.listeners) l.end();
            live.listeners.clear();
          });
        return json(res, 202, { id });
      }

      const cancelMatch = p.match(/^\/api\/runs\/([\w-]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        const live = runs.get(cancelMatch[1]);
        if (!live) return json(res, 404, { error: "run not found" });
        live.abort.abort();
        return json(res, 200, { ok: true });
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

      const docMatch = p.match(/^\/api\/runs\/([\w-]+)\/run\.json$/);
      if (req.method === "GET" && docMatch) {
        const r = runs.get(docMatch[1])?.result;
        if (!r) return json(res, 404, { error: "document not ready" });
        return json(res, 200, r);
      }

      // ── History (saved runs on disk) ───────────────────────────────────────
      if (req.method === "GET" && p === "/api/history") {
        const dir = settings().outputDir;
        const items = fs.existsSync(dir)
          ? fs
              .readdirSync(dir, { withFileTypes: true })
              .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "run.json")))
              .map((d) => {
                try {
                  const r = JSON.parse(fs.readFileSync(path.join(dir, d.name, "run.json"), "utf8"));
                  return { id: d.name, title: r.title, docType: r.docType, score: r.metrics?.finalScore, words: r.metrics?.words, at: r.trace?.[0]?.at };
                } catch {
                  return null;
                }
              })
              .filter(Boolean)
              .sort((a: any, b: any) => b.id.localeCompare(a.id))
              .slice(0, 40)
          : [];
        return json(res, 200, items);
      }

      const histMatch = p.match(/^\/api\/history\/([\w.-]+)$/);
      if (req.method === "GET" && histMatch) {
        const dir = path.join(settings().outputDir, histMatch[1]);
        if (!fs.existsSync(path.join(dir, "document.md"))) return json(res, 404, { error: "not found" });
        const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
        return json(res, 200, { ...run, markdown: fs.readFileSync(path.join(dir, "document.md"), "utf8") });
      }

      json(res, 404, { error: "not found" });
    } catch (e: any) {
      json(res, 500, { error: e?.message ?? String(e) });
    }
  });

  // Bound to localhost by default: the settings endpoint can write your API key.
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  await new Promise<void>((r) => server.listen(opts.port, host, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  console.log(`\n✒  Scriptorium is running at http://localhost:${port}${opts.mock ? "  (mock mode)" : ""}\n`);
  return server;
}

/** Very small HTML → readable text extractor for attached reference URLs. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim()).slice(0, 120);
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decode(body)
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, text };
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}
