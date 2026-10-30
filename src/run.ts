import * as fs from "node:fs";
import * as path from "node:path";
import { settings } from "./config.ts";
import { loadCorpus } from "./local-docs-node.ts";
import { runPipeline, type PipelineOptions, type RunResult } from "./pipeline.ts";
import type { DraftRequest } from "./types.ts";

export * from "./pipeline.ts";

export interface RunOptions extends Omit<PipelineOptions, "corpus" | "passScore"> {
  /** Save document.md + run.json under the output folder (default true). */
  save?: boolean;
  outputDir?: string;
}

/** Node entry point: loads ./data, runs the pipeline, saves the result to ./output. */
export async function runScriptorium(request: DraftRequest, opts: RunOptions): Promise<RunResult> {
  const cfg = settings();
  const corpus = loadCorpus(request.dataDir ?? cfg.dataDir);
  const result = await runPipeline(request, { ...opts, corpus, passScore: cfg.passScore });
  if (opts.save !== false) {
    const dir = path.join(opts.outputDir ?? cfg.outputDir, result.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "document.md"), result.markdown);
    const { markdown: _m, ...rest } = result;
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...rest, model: opts.llm.name }, null, 2));
    result.outputDir = dir;
  }
  opts.onEvent?.({ type: "done", result: { id: result.id, title: result.title, docType: result.docType, outputDir: result.outputDir, metrics: result.metrics } });
  return result;
}
