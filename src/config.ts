import * as fs from "node:fs";
import * as path from "node:path";

/** Minimal .env loader (no dependency). Existing env vars always win. */
export function loadEnv(file = path.join(process.cwd(), ".env")): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Update keys in .env (creating it if needed), preserving comments and other lines. */
export function saveEnv(updates: Record<string, string>, file = path.join(process.cwd(), ".env")): void {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));
  const out = lines.map((line) => {
    const m = line.match(/^\s*#?\s*([A-Z0-9_]+)\s*=/);
    if (m && pending.has(m[1])) {
      const v = pending.get(m[1])!;
      pending.delete(m[1]);
      return `${m[1]}=${v}`;
    }
    return line;
  });
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  fs.writeFileSync(file, out.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

/** Default Gemini model. If Google retires it, Scriptorium switches to the best available model automatically. */
export const DEFAULT_MODEL = "gemini-3.8-flash";

export interface Settings {
  apiKey?: string;
  model: string;
  researchModel: string;
  concurrency: number;
  passScore: number;
  outputDir: string;
  dataDir: string;
  port: number;
}

export function settings(): Settings {
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  return {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    model,
    researchModel: process.env.GEMINI_RESEARCH_MODEL || model,
    concurrency: Math.max(1, Number(process.env.SCRIPTORIUM_CONCURRENCY || 4)),
    passScore: Number(process.env.SCRIPTORIUM_PASS_SCORE || 8),
    outputDir: process.env.SCRIPTORIUM_OUTPUT_DIR || path.join(process.cwd(), "output"),
    dataDir: process.env.SCRIPTORIUM_DATA_DIR || path.join(process.cwd(), "data"),
    port: Number(process.env.PORT || 3000),
  };
}
