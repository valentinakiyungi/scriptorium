import type { Usage } from "../types.ts";
import type { GroundedResult, JsonRequest, LLM, TextRequest } from "./types.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";

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
}

/**
 * Google Gemini over the public REST API (no SDK dependency).
 * Handles retries with exponential backoff, JSON-mode output, and Google Search grounding.
 */
export class GeminiLLM implements LLM {
  readonly name: string;
  readonly usage: Usage = { calls: 0, promptTokens: 0, outputTokens: 0 };
  private readonly sem: Semaphore;
  private readonly opts: Required<GeminiOptions>;

  constructor(opts: GeminiOptions) {
    this.opts = {
      researchModel: opts.model,
      concurrency: 4,
      maxRetries: 4,
      ...opts,
    } as Required<GeminiOptions>;
    this.sem = new Semaphore(this.opts.concurrency);
    this.name = `gemini:${this.opts.model}`;
  }

  async text(req: TextRequest): Promise<string> {
    const res = await this.call(this.opts.model, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: { temperature: req.temperature ?? 0.4 },
    });
    return candidateText(res);
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const res = await this.call(this.opts.model, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        responseMimeType: "application/json",
        responseSchema: req.schema,
      },
    });
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
    const res = await this.call(this.opts.researchModel, {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: req.temperature ?? 0.2 },
    });
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

  private async call(model: string, body: unknown): Promise<any> {
    return this.sem.run(async () => {
      let attempt = 0;
      for (;;) {
        attempt++;
        let status = 0;
        let detail = "";
        try {
          const r = await fetch(`${API}/${model}:generateContent`, {
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
          detail = data?.error?.message ?? r.statusText;
        } catch (e: any) {
          if (e instanceof GeminiError) throw e;
          detail = e?.message ?? String(e);
        }
        const retryable = status === 0 || status === 429 || status >= 500;
        if (!retryable || attempt > this.opts.maxRetries) {
          throw new GeminiError(`Gemini ${model} failed (${status || "network"}): ${detail}`, status);
        }
        const wait = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, wait));
      }
    });
  }
}

function candidateText(res: any): string {
  const cand = res?.candidates?.[0];
  const parts: any[] = cand?.content?.parts ?? [];
  const text = parts.map((p) => p?.text ?? "").join("");
  if (!text && cand?.finishReason && cand.finishReason !== "STOP") {
    throw new GeminiError(`Gemini returned no text (finishReason=${cand.finishReason})`);
  }
  return text;
}
