// Static (GitHub Pages) build of Scriptorium: the whole LangGraph pipeline runs in the visitor's
// browser. Bring-your-own Gemini key, stored only in this browser's localStorage and sent only
// to Google. Without a key, visitors can run the offline demo.
import { DOC_TYPES } from "./doctypes.ts";
import { GeminiLLM, listModels, rankModels } from "./llm/gemini.ts";
import { MockLLM } from "./llm/mock.ts";
import { defaultRequest, runPipeline, slugify, type RunEvent, type RunResult } from "./pipeline.ts";

const DEFAULT_MODEL = "gemini-3.8-flash";
const API = (): string => (globalThis as any).SCRIPTORIUM_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";
const KEY = "scriptorium:settings";
const HISTORY = "scriptorium:history";

interface BrowserSettings {
  apiKey?: string;
  model?: string;
  researchModel?: string;
  passScore?: number;
  concurrency?: number;
}

const read = <T>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const write = (k: string, v: unknown): boolean => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};

const settings = (): Required<Omit<BrowserSettings, "apiKey">> & { apiKey: string } => {
  const s = read<BrowserSettings>(KEY, {});
  return {
    apiKey: s.apiKey ?? "",
    model: s.model || DEFAULT_MODEL,
    researchModel: s.researchModel ?? "",
    passScore: s.passScore ?? 8,
    concurrency: s.concurrency ?? 3,
  };
};

type HistoryItem = RunResult & { model: string };

export function createApi() {
  const runs = new Map<string, { abort: AbortController; result?: RunResult }>();

  return {
    mode: "static" as const,

    async config() {
      const s = settings();
      return {
        static: true,
        docTypes: DOC_TYPES.map((d) => ({
          id: d.id,
          label: d.label,
          description: d.description,
          defaultAudience: d.defaultAudience,
          examples: d.examples,
          targetWords: d.targetWords,
          sections: d.sections.map((x) => x.heading),
          researchSections: d.sections.filter((x) => x.research).length,
        })),
        model: s.apiKey ? s.model : "demo",
        ready: true, // without a key, Draft runs the offline demo
        hasKey: !!s.apiKey,
      };
    },

    async getSettings() {
      const s = settings();
      return { hasKey: !!s.apiKey, keyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : "", model: s.model, researchModel: s.researchModel, passScore: s.passScore, concurrency: s.concurrency };
    },

    async saveSettings(b: any) {
      const cur = read<BrowserSettings>(KEY, {});
      const next: BrowserSettings = { ...cur };
      if (typeof b.apiKey === "string" && b.apiKey.trim()) next.apiKey = b.apiKey.trim();
      if (b.removeKey) delete next.apiKey;
      if (typeof b.model === "string" && /^[\w.\-]+$/.test(b.model)) next.model = b.model;
      if (typeof b.researchModel === "string" && /^[\w.\-]*$/.test(b.researchModel)) next.researchModel = b.researchModel;
      if (Number.isFinite(+b.passScore)) next.passScore = Math.max(1, Math.min(10, Math.round(+b.passScore)));
      if (Number.isFinite(+b.concurrency)) next.concurrency = Math.max(1, Math.min(16, Math.round(+b.concurrency)));
      write(KEY, next);
      return { ok: true };
    },

    async testKey(b: { apiKey?: string; model?: string }) {
      const key = b.apiKey?.trim() || settings().apiKey;
      const model = b.model || settings().model;
      if (!key) return { ok: false, message: "No API key entered." };
      try {
        const r = await fetch(`${API()}/${encodeURIComponent(model)}`, { headers: { "x-goog-api-key": key } });
        const d: any = await r.json().catch(() => ({}));
        if (r.ok) return { ok: true, message: `Connected — ${d.displayName ?? model} is available.` };
        if (r.status === 404 || r.status === 400) {
          const best = await listModels(key).then((m) => rankModels(m.map((x) => x.id))[0]).catch(() => undefined);
          if (best) return { ok: false, suggest: best, message: `Your key works, but "${model}" isn't available to it. Use ${best} instead.` };
        }
        return { ok: false, message: d?.error?.message ?? `HTTP ${r.status}` };
      } catch (e: any) {
        return { ok: false, message: `Could not reach Gemini: ${e?.message ?? e}` };
      }
    },

    async models(b: { apiKey?: string }) {
      const key = b.apiKey?.trim() || settings().apiKey;
      if (!key) return { models: [] };
      try {
        const all = await listModels(key);
        const order = rankModels(all.map((m) => m.id));
        const byId = new Map(all.map((m) => [m.id, m]));
        return { models: order.map((id) => byId.get(id)), recommended: order[0] ?? null };
      } catch (e: any) {
        return { models: [], error: e?.message ?? String(e) };
      }
    },

    async fetchUrl(url: string) {
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
      } catch {
        return { error: "Enter a valid http(s) URL." };
      }
      try {
        const r = await fetch(url);
        if (!r.ok) return { error: `The page returned HTTP ${r.status}.` };
        const doc = new DOMParser().parseFromString(await r.text(), "text/html");
        doc.querySelectorAll("script,style,noscript,nav,footer,header,form,iframe,svg").forEach((n) => n.remove());
        const text = (doc.body?.innerText || doc.body?.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
        if (text.length < 200) return { error: "Couldn't extract readable text from that page." };
        return { name: doc.title?.trim().slice(0, 120) || new URL(url).hostname, url, text: text.slice(0, 400_000) };
      } catch {
        return { error: "That site doesn't allow other websites to read it. Open the page, copy the text, and use Paste text instead." };
      }
    },

    async history() {
      return read<HistoryItem[]>(HISTORY, []).map((r) => ({ id: r.id, title: r.title, docType: r.docType, score: r.metrics?.finalScore, words: r.metrics?.words }));
    },

    async historyItem(id: string) {
      return read<HistoryItem[]>(HISTORY, []).find((r) => r.id === id) ?? null;
    },

    async startRun(body: any, onEvent: (e: RunEvent | { type: "result"; result: RunResult }) => void) {
      const s = settings();
      const demo = !s.apiKey || body.mock === true;
      const llm = demo
        ? new MockLLM(350)
        : new GeminiLLM({
            apiKey: s.apiKey,
            model: s.model,
            researchModel: s.researchModel || s.model,
            concurrency: s.concurrency,
            onModelChange: ({ to, role, reason }) => {
              // Retired models are replaced permanently; quota switches only last for this run.
              if (reason === "unavailable") write(KEY, { ...read<BrowserSettings>(KEY, {}), ...(role === "main" ? { model: to } : {}) });
            },
          });
      const request = defaultRequest({
        topic: String(body.topic ?? "").slice(0, 1000),
        docType: body.docType,
        audience: body.audience || undefined,
        instructions: body.instructions || undefined,
        maxQuestions: Math.max(1, Math.min(20, Number(body.maxQuestions) || 6)),
        maxRevisions: Math.max(0, Math.min(3, Number(body.maxRevisions ?? 1))),
        web: body.web !== false,
      });
      const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${slugify(request.topic).slice(0, 40)}`;
      const abort = new AbortController();
      runs.set(id, { abort });
      if (demo) onEvent({ type: "trace", event: { at: new Date().toISOString(), agent: "gemini", ms: 0, message: "Demo mode — simulated agents and placeholder sources. Add a Gemini API key in Settings for real research." } });

      runPipeline(request, { llm, references: body.references ?? [], passScore: s.passScore, signal: abort.signal, onEvent })
        .then((result) => {
          result.id = id;
          runs.get(id)!.result = result;
          // Keep the 15 most recent documents in this browser.
          const hist = [{ ...result, model: llm.name }, ...read<HistoryItem[]>(HISTORY, []).filter((r) => r.id !== id)];
          while (hist.length && !write(HISTORY, hist.slice(0, 15))) hist.splice(-1, 1);
          onEvent({ type: "result", result });
        })
        .catch((e) => onEvent({ type: "error", message: abort.signal.aborted ? "Run stopped." : (e?.message ?? String(e)) }));
      return id;
    },

    async cancel(id: string) {
      runs.get(id)?.abort.abort();
    },
  };
}
