import * as fs from "node:fs";
import * as path from "node:path";
import { countCitations } from "./citations.ts";
import { settings } from "./config.ts";
import { getDocType } from "./doctypes.ts";
import { buildGraph, type State } from "./graph.ts";
import { LocalCorpus } from "./local-docs.ts";
import type { LLM } from "./llm/types.ts";
import type { DraftRequest, Finding, Plan, Review, SectionDraft, Source, TraceEvent, Usage } from "./types.ts";

export type RunEvent =
  | { type: "start"; request: DraftRequest; model: string; localChunks: number }
  | { type: "trace"; event: TraceEvent }
  | { type: "plan"; plan: Plan }
  | { type: "finding"; finding: Pick<Finding, "id" | "question" | "sectionId" | "ms"> & { sources: number } }
  | { type: "section"; section: SectionDraft }
  | { type: "draft"; markdown: string; iteration: number }
  | { type: "review"; review: Review }
  | { type: "done"; result: RunSummary }
  | { type: "error"; message: string };

export interface RunMetrics {
  totalMs: number;
  agentMs: Record<string, number>;
  llmCalls: number;
  promptTokens: number;
  outputTokens: number;
  researchQuestions: number;
  uniqueSources: number;
  citedReferences: number;
  citations: number;
  words: number;
  revisions: number;
  finalScore: number | null;
}

export interface RunSummary {
  id: string;
  title: string;
  docType: string;
  outputDir?: string;
  metrics: RunMetrics;
}

export interface RunResult extends RunSummary {
  request: DraftRequest;
  plan: Plan;
  markdown: string;
  references: Source[];
  sources: Source[];
  findings: Finding[];
  reviews: Review[];
  trace: TraceEvent[];
  usage: Usage;
}

export interface RunOptions {
  llm: LLM;
  onEvent?: (e: RunEvent) => void;
  save?: boolean;
  outputDir?: string;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";
}

export function defaultRequest(partial: Partial<DraftRequest> & { topic: string }): DraftRequest {
  return {
    docType: "research-report",
    maxRevisions: 1,
    maxQuestions: 8,
    web: true,
    ...partial,
  };
}

/** Run the full Supervisor-Worker pipeline for one document. */
export async function runScriptorium(request: DraftRequest, opts: RunOptions): Promise<RunResult> {
  getDocType(request.docType); // validate early
  if (!request.topic?.trim()) throw new Error("A topic is required.");
  const cfg = settings();
  const emit = opts.onEvent ?? (() => {});
  const corpus = LocalCorpus.load(request.dataDir ?? cfg.dataDir);
  const graph = buildGraph({ llm: opts.llm, corpus, passScore: cfg.passScore });
  const started = Date.now();
  const id = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${slugify(request.topic).slice(0, 40)}`;

  emit({ type: "start", request, model: opts.llm.name, localChunks: corpus.size });

  let state: Partial<State> = {};
  const stream = await graph.stream({ request }, { streamMode: ["updates", "values"], recursionLimit: 200 });
  for await (const chunk of stream as AsyncIterable<[string, any]>) {
    const [mode, data] = chunk;
    if (mode === "values") {
      state = data;
      continue;
    }
    for (const [node, upd] of Object.entries<any>(data ?? {})) {
      for (const t of upd?.trace ?? []) emit({ type: "trace", event: t });
      if (node === "planner" && upd.plan) emit({ type: "plan", plan: upd.plan });
      if (node === "researcher") {
        for (const f of upd.findings ?? []) {
          emit({ type: "finding", finding: { id: f.id, question: f.question, sectionId: f.sectionId, ms: f.ms, sources: f.rawSources.length } });
        }
      }
      if (node === "writer") for (const s of Object.values<SectionDraft>(upd.sections ?? {})) emit({ type: "section", section: s });
      if (node === "assembler") emit({ type: "draft", markdown: upd.document, iteration: upd.draftIteration });
      if (node === "reviewer" && upd.review) emit({ type: "review", review: upd.review });
    }
  }

  const s = state as State;
  if (!s.document) throw new Error("The pipeline finished without producing a document.");

  const agentMs: Record<string, number> = {};
  for (const t of s.trace) agentMs[t.agent] = (agentMs[t.agent] ?? 0) + t.ms;
  const body = s.assembled.map((x) => x.body).join("\n\n");
  const metrics: RunMetrics = {
    totalMs: Date.now() - started,
    agentMs,
    llmCalls: opts.llm.usage.calls,
    promptTokens: opts.llm.usage.promptTokens,
    outputTokens: opts.llm.usage.outputTokens,
    researchQuestions: s.tasks.length,
    uniqueSources: s.sources.length,
    citedReferences: s.references.length,
    citations: countCitations(body),
    words: body.split(/\s+/).filter(Boolean).length,
    revisions: s.iteration,
    finalScore: s.review?.score ?? null,
  };

  const result: RunResult = {
    id,
    title: s.plan!.title,
    docType: request.docType,
    request,
    plan: s.plan!,
    markdown: s.document,
    references: s.references,
    sources: s.sources,
    findings: s.findings,
    reviews: s.reviews,
    trace: s.trace,
    usage: { ...opts.llm.usage },
    metrics,
  };

  if (opts.save !== false) {
    const dir = path.join(opts.outputDir ?? cfg.outputDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "document.md"), result.markdown);
    const { markdown: _m, ...rest } = result;
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ ...rest, model: opts.llm.name }, null, 2));
    result.outputDir = dir;
  }

  emit({ type: "done", result: { id, title: result.title, docType: result.docType, outputDir: result.outputDir, metrics } });
  return result;
}
