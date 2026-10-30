import * as fs from "node:fs";
import * as path from "node:path";
import { settings } from "./config.ts";
import { DOC_TYPES } from "./doctypes.ts";
import { createLLM } from "./llm/index.ts";
import { defaultRequest, runScriptorium } from "./run.ts";

/** One representative task per document type. */
export const BENCH_TASKS: { docType: string; topic: string; audience?: string }[] = [
  { docType: "research-report", topic: "The state of grid-scale battery storage deployment" },
  { docType: "literature-review", topic: "Effects of remote work on employee productivity" },
  { docType: "executive-brief", topic: "Adopting AI coding assistants in a 200-person engineering org" },
  { docType: "policy-memo", topic: "Reducing urban heat island effects in mid-sized cities" },
  { docType: "technical-whitepaper", topic: "Retrieval-augmented generation for enterprise search" },
  { docType: "blog-article", topic: "Why microplastics are showing up in drinking water" },
  { docType: "grant-proposal", topic: "A community programme to improve adult digital literacy" },
];

export async function runBenchmark(opts: { mock?: boolean; baselineMinutes?: number; out?: string }) {
  const rows: Record<string, unknown>[] = [];
  console.log(`\nScriptorium benchmark — ${BENCH_TASKS.length} tasks across ${DOC_TYPES.length} document types\n`);
  for (const task of BENCH_TASKS) {
    const llm = createLLM({ mock: opts.mock });
    process.stdout.write(`• ${task.docType.padEnd(22)} `);
    try {
      const r = await runScriptorium(defaultRequest({ ...task, maxQuestions: 6, maxRevisions: 1 }), { llm, outputDir: opts.out });
      const m = r.metrics;
      rows.push({ docType: task.docType, topic: task.topic, seconds: +(m.totalMs / 1000).toFixed(1), words: m.words, references: m.citedReferences, citations: m.citations, score: m.finalScore, revisions: m.revisions, llmCalls: m.llmCalls, tokens: m.promptTokens + m.outputTokens, output: r.outputDir });
      console.log(`${(m.totalMs / 1000).toFixed(1)}s · ${m.words}w · ${m.citedReferences} refs · score ${m.finalScore}/10`);
    } catch (e: any) {
      rows.push({ docType: task.docType, topic: task.topic, error: e?.message ?? String(e) });
      console.log(`FAILED: ${e?.message ?? e}`);
    }
  }

  const ok = rows.filter((r) => !r.error) as any[];
  const avg = (k: string) => ok.reduce((a, r) => a + r[k], 0) / Math.max(1, ok.length);
  const summary: Record<string, unknown> = {
    tasks: rows.length,
    succeeded: ok.length,
    avgSeconds: +avg("seconds").toFixed(1),
    avgWords: Math.round(avg("words")),
    avgReferences: +avg("references").toFixed(1),
    avgScore: +avg("score").toFixed(1),
  };
  if (opts.baselineMinutes) {
    // Time saved vs. a human baseline you measured yourself (minutes per document).
    const reviewMinutes = 15; // assumed human review/edit pass on the AI draft
    const aiMinutes = avg("seconds") / 60 + reviewMinutes;
    summary.baselineMinutes = opts.baselineMinutes;
    summary.assumedReviewMinutes = reviewMinutes;
    summary.timeSavedPct = Math.round((1 - aiMinutes / opts.baselineMinutes) * 100);
  }

  const dir = opts.out ?? settings().outputDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `benchmark-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nSummary: ${JSON.stringify(summary)}`);
  console.log(`Saved ${file}\n`);
  return { summary, rows };
}
