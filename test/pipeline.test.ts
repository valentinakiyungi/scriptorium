import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DOC_TYPES } from "../src/doctypes.ts";
import { MockLLM } from "../src/llm/mock.ts";
import { defaultRequest, runScriptorium, type RunEvent } from "../src/run.ts";

process.env.SCRIPTORIUM_RESOLVE_URLS = "0";
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-empty-"));

test("full Supervisor-Worker run produces a cited document and revises once", async () => {
  const events: RunEvent[] = [];
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-"));
  const r = await runScriptorium(defaultRequest({ topic: "urban heat islands", docType: "policy-memo", maxQuestions: 5, dataDir: empty }), {
    llm: new MockLLM(5),
    outputDir: out,
    onEvent: (e) => events.push(e),
  });

  assert.match(r.markdown, /^# Urban Heat Islands/);
  for (const h of ["Summary", "Problem Statement", "Policy Options", "References"]) assert.ok(r.markdown.includes(`## ${h}`), h);
  assert.equal(r.reviews.length, 2, "one failing review, one passing review");
  assert.equal(r.metrics.revisions, 1);
  assert.equal(r.metrics.finalScore, 8);
  assert.equal(r.metrics.researchQuestions, 6, "5 planned + 1 gap question");
  assert.ok(r.metrics.citedReferences > 0);

  // Every citation points at a listed reference.
  const refIds = new Set(r.references.map((x) => x.id));
  for (const m of r.markdown.matchAll(/\[(\d+)\](?!\()/g)) assert.ok(refIds.has(Number(m[1])), `citation ${m[0]}`);
  // References are numbered 1..n in order.
  assert.deepEqual(r.references.map((x) => x.id), r.references.map((_, i) => i + 1));
  // Tracking params are stripped during de-duplication, so the same URL isn't listed twice.
  assert.equal(new Set(r.sources.map((s) => s.url.split("?")[0])).size, r.sources.length);

  assert.ok(fs.existsSync(path.join(r.outputDir!, "document.md")));
  const saved = JSON.parse(fs.readFileSync(path.join(r.outputDir!, "run.json"), "utf8"));
  assert.equal(saved.title, r.title);

  const agents = new Set(events.filter((e) => e.type === "trace").map((e: any) => e.event.agent));
  for (const a of ["supervisor", "planner", "researcher", "collator", "writer", "assembler", "reviewer"]) assert.ok(agents.has(a), a);
  assert.equal(events.at(-1)!.type, "done");
});

test("researchers and writers run in parallel", async () => {
  const llm = new MockLLM(80);
  const t0 = Date.now();
  const r = await runScriptorium(defaultRequest({ topic: "parallelism", docType: "research-report", maxQuestions: 8, maxRevisions: 0, dataDir: empty }), { llm, save: false });
  const elapsed = Date.now() - t0;
  // Sequential would be ≥ (1 plan + 8 research + 6 write + 1 review) × 80ms = 1280ms.
  assert.ok(elapsed < 900, `took ${elapsed}ms — workers do not appear to run concurrently`);
  assert.equal(r.metrics.llmCalls, 16);
});

test("every document type completes end-to-end", async () => {
  for (const d of DOC_TYPES) {
    const r = await runScriptorium(defaultRequest({ topic: `test topic for ${d.id}`, docType: d.id, maxQuestions: 3, maxRevisions: 0, dataDir: empty }), { llm: new MockLLM(), save: false });
    assert.equal(r.plan.sections.length, d.sections.length, d.id);
    assert.ok(r.metrics.words > 100, d.id);
  }
});

test("offline mode uses local documents as citable sources", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scriptorium-data-"));
  fs.writeFileSync(path.join(dir, "notes.md"), "Important facts about local research questions and topic data trends.");
  const r = await runScriptorium(defaultRequest({ topic: "local research", docType: "executive-brief", web: false, dataDir: dir, maxRevisions: 0 }), { llm: new MockLLM(), save: false });
  assert.ok(r.references.some((x) => x.kind === "local" && x.title === "notes.md"));
  assert.match(r.markdown, /notes\.md \*\(local document\)\*/);
});

test("rejects unknown document types and empty topics", async () => {
  await assert.rejects(runScriptorium(defaultRequest({ topic: "x", docType: "sonnet" }), { llm: new MockLLM(), save: false }), /Unknown document type/);
  await assert.rejects(runScriptorium(defaultRequest({ topic: "  " }), { llm: new MockLLM(), save: false }), /topic is required/i);
});
