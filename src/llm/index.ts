import * as fs from "node:fs";
import * as path from "node:path";
import { saveEnv, settings } from "../config.ts";
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
  return new GeminiLLM({
    apiKey: cfg.apiKey,
    model: cfg.model,
    researchModel: cfg.researchModel,
    concurrency: cfg.concurrency,
    onModelChange: ({ from, to, role, reason }) => {
      const what = role === "research" ? "research model" : "model";
      if (reason === "quota") {
        // Quota resets daily, so this switch is for this run only — don't rewrite .env.
        console.warn(`\n⚠  Gemini ${from} is out of quota for today — using "${to}" as the ${what} for now.`);
        return;
      }
      console.warn(`\n⚠  Gemini model "${from}" is unavailable for this key — switched ${what} to "${to}".`);
      // Remember the working model so the next run starts with it (only if the user keeps settings in .env).
      // A research model left blank means "same as main", so only pin it if the user set one.
      if (fs.existsSync(path.join(process.cwd(), ".env"))) {
        if (role === "main") saveEnv({ GEMINI_MODEL: to });
        else if (process.env.GEMINI_RESEARCH_MODEL) saveEnv({ GEMINI_RESEARCH_MODEL: to });
      }
    },
  });
}

export type { LLM } from "./types.ts";
