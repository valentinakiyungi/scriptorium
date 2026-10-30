import { settings } from "../config.ts";
import { GeminiLLM } from "./gemini.ts";
import { MockLLM } from "./mock.ts";
import type { LLM } from "./types.ts";

export function createLLM(opts: { mock?: boolean } = {}): LLM {
  const cfg = settings();
  if (opts.mock || process.env.SCRIPTORIUM_MOCK === "1") return new MockLLM(Number(process.env.SCRIPTORIUM_MOCK_LATENCY || 0));
  if (!cfg.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey and put it in .env, or run with --mock for an offline demo.",
    );
  }
  return new GeminiLLM({ apiKey: cfg.apiKey, model: cfg.model, researchModel: cfg.researchModel, concurrency: cfg.concurrency });
}

export type { LLM } from "./types.ts";
