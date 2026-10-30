import type { Usage } from "../types.ts";
import type { GroundedResult, JsonRequest, LLM, TextRequest } from "./types.ts";

/** Overridable for tests / proxies. */
const apiBase = () => process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta/models";

/** Simple counting semaphore so parallel workers don't blow through rate limits. */
export class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export class GeminiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

interface GeminiOptions {
  apiKey: string;
  model: string;
  researchModel?: string;
  concurrency?: number;
  maxRetries?: number;
  /** Called when a retired/unavailable model is replaced automatically. */
  onModelChange?: (change: { from: string; to: string; role: ModelRole; reason: "unavailable" | "quota" }) => void;
}

type ModelRole = "main" | "research";
type ResolvedOptions = Required<Omit<GeminiOptions, "onModelChange">> & Pick<GeminiOptions, "onModelChange">;

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
}

/** List the Gemini models this API key can call with generateContent. */
export async function listModels(apiKey: string): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`${apiBase()}?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ""}`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new GeminiError(d?.error?.message ?? `Could not list models (HTTP ${r.status})`, r.status);
    for (const m of d.models ?? []) {
      if (!(m.supportedGenerationMethods ?? []).includes("generateContent")) continue;
      const id = String(m.name ?? "").replace(/^models\//, "");
      if (/^gemini-/.test(id)) out.push({ id, displayName: m.displayName ?? id, description: m.description });
    }
    pageToken = d.nextPageToken ?? "";
    if (!pageToken) break;
  }
  return out;
}

/** Rank text models: stable Flash first, newest version first; skip image/audio/live/embedding variants. */
export function rankModels(ids: string[]): string[] {
  const special = /(image|audio|tts|live|embedding|vision|robotics|computer-use|native|thinking-exp|learnlm|aqa)/;
  const version = (id: string) => Number(id.match(/^gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const tier = (id: string) => {
    if (/^gemini-\d+(\.\d+)?-flash$/.test(id)) return 0; // stable flash
    if (/^gemini-flash-latest$/.test(id)) return 1;
    if (/-flash(-\d{3})?$/.test(id) && !/lite/.test(id)) return 2;
    if (/-flash/.test(id) && !/lite/.test(id)) return 3; // previews
    if (/^gemini-\d+(\.\d+)?-pro$/.test(id)) return 4;
    if (/lite/.test(id)) return 5;
    return 6;
  };
  return ids
    .filter((id) => /^gemini-/.test(id) && !special.test(id))
    .sort((a, b) => tier(a) - tier(b) || version(b) - version(a) || a.localeCompare(b));
}

/** Gemini 3+ models are tuned for their default temperature; only older models get an explicit one. */
export function supportsTemperature(model: string): boolean {
  return /^gemini-(1|2)(\.|-)/.test(model);
}

function isUnavailableModel(status: number, detail: string): boolean {
  return status === 404 || (status === 400 && /model.*(not found|no longer available|not supported|is not available|deprecated)/i.test(detail));
}

export interface QuotaInfo {
  /** A daily (or otherwise long) quota: retrying the same model today is pointless. */
  exhausted: boolean;
  /** How long Google asks us to wait, if it says. */
  retryMs?: number;
  limit?: string;
}

/** Read Google's 429 details (QuotaFailure + RetryInfo) to tell a per-minute limit from a daily one. */
export function parseQuota(error: any): QuotaInfo {
  const details: any[] = Array.isArray(error?.details) ? error.details : [];
  const message = String(error?.message ?? "");
  let retryMs: number | undefined;
  const delay = details.find((d) => /RetryInfo/.test(d?.["@type"] ?? ""))?.retryDelay ?? message.match(/retry in ([\d.]+)s/i)?.[1];
  if (delay !== undefined) retryMs = Math.round(parseFloat(String(delay)) * 1000);
  const hm = message.match(/retry in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  if (hm) retryMs = ((+hm[1] || 0) * 3600 + (+hm[2] || 0) * 60 + parseFloat(hm[3])) * 1000;
  const violations: any[] = details.flatMap((d) => d?.violations ?? []);
  const daily = violations.some((v) => /PerDay|per.?day/i.test(`${v?.quotaId ?? ""} ${v?.quotaMetric ?? ""}`)) || /per day|daily/i.test(message);
  const limit = violations.find((v) => v?.quotaValue)?.quotaValue ?? message.match(/limit: (\d+)/)?.[1];
  return { exhausted: daily || (retryMs ?? 0) > 120_000, retryMs, limit };
}

/** Models whose quota is used up, shared across runs in this process: model -> time it frees up. */
const exhaustedUntil = new Map<string, number>();
export function isExhausted(model: string): boolean {
  const t = exhaustedUntil.get(model);
  if (t && t < Date.now()) exhaustedUntil.delete(model);
  return exhaustedUntil.has(model);
}
export function resetQuotaMemory(): void {
  exhaustedUntil.clear();
}

export class QuotaError extends GeminiError {}

function humanWait(ms?: number): string {
  if (!ms) return "later today";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h ? `in about ${h}h ${m}m` : `in about ${Math.max(1, m)} min`;
}

/**
 * Google Gemini over the public REST API (no SDK dependency).
 * Handles retries with exponential backoff, JSON-mode output, and Google Search grounding.
 */
export class GeminiLLM implements LLM {
  readonly usage: Usage = { calls: 0, promptTokens: 0, outputTokens: 0 };
  private readonly sem: Semaphore;
  private readonly opts: ResolvedOptions;
  private switching = new Map<string, Promise<string | null>>();
  private unavailable = new Set<string>();
  private modelCache?: Promise<string[]>;
  /** Optional live status messages (rate-limit waits, model switches) for the UI. */
  onNotice?: (message: string) => void;

  constructor(opts: GeminiOptions) {
    this.opts = {
      researchModel: opts.model,
      concurrency: 4,
      maxRetries: 4,
      ...opts,
    } as ResolvedOptions;
    this.sem = new Semaphore(this.opts.concurrency);
  }

  get name(): string {
    return `gemini:${this.opts.model}`;
  }

  private modelFor(role: ModelRole): string {
    return role === "research" ? this.opts.researchModel : this.opts.model;
  }

  private gen(role: ModelRole, temperature: number, extra: Record<string, unknown> = {}) {
    return supportsTemperature(this.modelFor(role)) ? { temperature, ...extra } : { ...extra };
  }

  async text(req: TextRequest): Promise<string> {
    const res = await this.call("main", () => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: this.gen("main", req.temperature ?? 0.4),
    }));
    return candidateText(res);
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const res = await this.call("main", () => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: this.gen("main", req.temperature ?? 0.2, { responseMimeType: "application/json", responseSchema: req.schema }),
    }));
    const raw = candidateText(res);
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Defensive: strip code fences if a model wraps JSON anyway.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]) as T;
      throw new GeminiError(`Model returned invalid JSON for ${req.purpose}: ${raw.slice(0, 200)}`);
    }
  }

  async search(req: TextRequest): Promise<GroundedResult> {
    const res = await this.call("research", () => ({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: this.gen("research", req.temperature ?? 0.2),
    }));
    const text = candidateText(res);
    const meta = res?.candidates?.[0]?.groundingMetadata ?? {};
    const chunks = (meta.groundingChunks ?? []).map((c: any) => ({
      uri: c?.web?.uri ?? "",
      title: c?.web?.title ?? c?.web?.domain ?? "Untitled source",
    }));
    const supports = (meta.groundingSupports ?? [])
      .filter((s: any) => s?.segment && Array.isArray(s.groundingChunkIndices))
      .map((s: any) => ({
        startIndex: s.segment.startIndex ?? 0,
        endIndex: s.segment.endIndex ?? 0,
        text: s.segment.text ?? "",
        chunkIndices: s.groundingChunkIndices as number[],
      }));
    return { text, chunks, supports, queries: meta.webSearchQueries ?? [] };
  }

  private rankedModels(): Promise<string[]> {
    this.modelCache ??= listModels(this.opts.apiKey)
      .then((m) => rankModels(m.map((x) => x.id)))
      .catch(() => {
        this.modelCache = undefined;
        return [];
      });
    return this.modelCache;
  }

  /**
   * Replace a model that is retired or out of quota with the best model this key can still use.
   * Shared per failed model so parallel workers switch once, not N times.
   */
  private switchModel(role: ModelRole, failed: string, reason: "unavailable" | "quota"): Promise<string | null> {
    if (this.modelFor(role) !== failed) return Promise.resolve(this.modelFor(role)); // another worker already switched
    let p = this.switching.get(failed);
    if (!p) {
      p = (async () => {
        const next = (await this.rankedModels()).find((id) => id !== failed && !this.unavailable.has(id) && !isExhausted(id));
        if (!next) return null;
        for (const r of ["main", "research"] as ModelRole[]) {
          const cur = this.modelFor(r);
          if (cur !== failed) continue;
          if (r === "main") this.opts.model = next;
          else this.opts.researchModel = next;
          this.opts.onModelChange?.({ from: cur, to: next, role: r, reason });
        }
        this.onNotice?.(
          reason === "quota"
            ? `${failed} hit its quota for today — switched to ${next}, which has its own quota.`
            : `${failed} isn't available to this key — switched to ${next}.`,
        );
        return next;
      })();
      this.switching.set(failed, p);
    }
    return p;
  }

  private async call(role: ModelRole, makeBody: () => unknown): Promise<any> {
    return this.sem.run(async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        let model = this.modelFor(role);
        // Skip a model already known to be out of quota (e.g. from an earlier run in this session).
        if (isExhausted(model)) {
          const next = await this.switchModel(role, model, "quota");
          if (!next) throw this.quotaError(model);
          model = next;
        }
        const body = makeBody();
        let status = 0;
        let detail = "";
        let error: any;
        try {
          const r = await fetch(`${apiBase()}/${model}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
          });
          status = r.status;
          const data: any = await r.json().catch(() => ({}));
          if (r.ok) {
            this.usage.calls++;
            this.usage.promptTokens += data?.usageMetadata?.promptTokenCount ?? 0;
            this.usage.outputTokens += data?.usageMetadata?.candidatesTokenCount ?? 0;
            const block = data?.promptFeedback?.blockReason;
            if (block) throw new GeminiError(`Gemini blocked the prompt (${block})`, 400);
            return data;
          }
          error = data?.error;
          detail = error?.message ?? r.statusText;
        } catch (e: any) {
          if (e instanceof GeminiError) throw e;
          detail = e?.message ?? String(e);
        }

        // Retired / unavailable model → switch and retry immediately.
        if (isUnavailableModel(status, detail)) {
          this.unavailable.add(model);
          const next = await this.switchModel(role, model, "unavailable");
          if (next && next !== model) {
            attempt--;
            continue;
          }
        }

        if (status === 429) {
          const q = parseQuota(error ?? { message: detail });
          if (q.exhausted) {
            // Daily quota: retrying this model is pointless. Move to a model with its own quota.
            exhaustedUntil.set(model, Date.now() + (q.retryMs ?? 6 * 3_600_000));
            this.quotaInfo.set(model, q);
            const next = await this.switchModel(role, model, "quota");
            if (next && next !== model) {
              attempt--;
              continue;
            }
            throw this.quotaError(model);
          }
          if (attempt <= this.opts.maxRetries) {
            // Per-minute limit: wait as long as Google asks (capped), then retry.
            const wait = Math.min(65_000, q.retryMs ?? 1000 * 2 ** attempt) + Math.random() * 500;
            if (attempt === 1) this.onNotice?.(`Rate limited by Gemini — waiting ${Math.ceil(wait / 1000)}s before retrying.`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
        }

        const retryable = status === 0 || status >= 500;
        if (!retryable || attempt > this.opts.maxRetries) {
          throw new GeminiError(`Gemini ${model} failed (${status || "network"}): ${detail}`, status);
        }
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, wait));
      }
    });
  }

  private quotaInfo = new Map<string, QuotaInfo>();

  private quotaError(model: string): QuotaError {
    const q = this.quotaInfo.get(model);
    const limit = q?.limit ? ` (${q.limit} requests/day on the free tier)` : "";
    return new QuotaError(
      `Gemini's daily quota is used up for ${model}${limit} and for every other model this key can use. ` +
        `It resets ${humanWait(q?.retryMs)}. To keep going now: enable billing for your key in Google AI Studio (pay-as-you-go raises the limits immediately), ` +
        `or use a smaller run — fewer research questions and 0 revisions.`,
      429,
    );
  }
}

function candidateText(res: any): string {
  const cand = res?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  // Skip thought-summary parts that newer models can return alongside the answer.
  const text = parts.filter((p) => !p?.thought).map((p) => p?.text ?? "").join("");
  if (!text && cand?.finishReason && cand.finishReason !== "STOP") {
    throw new GeminiError(`Gemini returned no text (finishReason=${cand.finishReason})`);
  }
  return text;
}
