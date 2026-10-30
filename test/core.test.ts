import { test } from "node:test";
import assert from "node:assert/strict";
import { collate, insertGroundingMarkers, normalizeCitations, renumber } from "../src/citations.ts";
import { DOC_TYPES, getDocType } from "../src/doctypes.ts";
import { LocalCorpus } from "../src/local-docs.ts";
import { normalizePlan } from "../src/agents/planner.ts";
import { decide, sectionsToWrite } from "../src/agents/supervisor.ts";
import { lintSections } from "../src/agents/reviewer.ts";
import { defaultRequest } from "../src/run.ts";
import type { Finding, Plan, Review } from "../src/types.ts";

test("ships at least 5 document types with unique ids and rubrics", () => {
  assert.ok(DOC_TYPES.length >= 5);
  assert.equal(new Set(DOC_TYPES.map((d) => d.id)).size, DOC_TYPES.length);
  for (const d of DOC_TYPES) {
    assert.ok(d.sections.length >= 4, d.id);
    assert.ok(d.rubric.length >= 3, d.id);
    assert.ok(d.sections.some((s) => s.research), `${d.id} needs a research section`);
  }
  assert.throws(() => getDocType("nope"), /Unknown document type/);
});

test("grounding markers are inserted at UTF-8 byte offsets", () => {
  const s1 = "Café prices rose 12%.";
  const s2 = " Rents fell.";
  const text = s1 + s2;
  const out = insertGroundingMarkers(text, [
    { startIndex: 0, endIndex: Buffer.byteLength(s1), text: s1, chunkIndices: [1, 0] },
    { startIndex: Buffer.byteLength(s1), endIndex: Buffer.byteLength(text), text: s2, chunkIndices: [2] },
  ]);
  assert.equal(out, "Café prices rose 12%.[[0]][[1]] Rents fell.[[2]]");
});

test("collate de-duplicates sources across researchers and rewrites markers", () => {
  const f = (id: string, urls: string[], notes: string): Finding => ({
    id, taskId: id, sectionId: "s", question: id, rawNotes: notes, ms: 1,
    rawSources: urls.map((url) => ({ url, title: url, kind: "web" as const })),
  });
  const { sources, findings } = collate([], [
    f("a", ["https://www.x.org/p?utm_source=z", "https://y.org/q"], "A[[0]] B[[1]]"),
    f("b", ["https://y.org/q/", "https://x.org/p"], "C[[0]][[1]] D[[9]]"),
  ]);
  assert.equal(sources.length, 2);
  assert.equal(findings[0].notes, "A[1] B[2]");
  assert.equal(findings[1].notes, "C[2][1] D");
});

test("normalizeCitations expands lists and ranges", () => {
  assert.equal(normalizeCitations("x [1, 3] y [4-6] z [2][2]"), "x [1][3] y [4][5][6] z [2][2]");
  assert.equal(normalizeCitations("a [link](http://x) [1]"), "a [link](http://x) [1]");
});

test("renumber orders by first appearance and drops invented citations", () => {
  const sources = [5, 9, 12].map((id) => ({ id, url: `https://s${id}.org`, title: `S${id}`, kind: "web" as const }));
  const { bodies, references, dropped } = renumber(["Claim [9]. Other [99] .", "More [5][9] and [12, 9]."], sources);
  assert.deepEqual(bodies, ["Claim [1]. Other.", "More [2][1] and [3][1]."]);
  assert.deepEqual(references.map((r) => [r.id, r.title]), [[1, "S9"], [2, "S5"], [3, "S12"]]);
  assert.equal(dropped, 1);
});

test("planner output is forced onto the template and question budget", () => {
  const dt = getDocType("policy-memo");
  const req = defaultRequest({ topic: "heat", docType: dt.id, maxQuestions: 4 });
  const plan = normalizePlan(
    { title: "T", sections: [{ id: "problem", heading: "The Problem", goal: "g", questions: ["What is the scale of urban heat?", "Who is most affected by heat?", "How many deaths per year?"] }, { id: "bogus", heading: "x", goal: "x", questions: ["q?"] }] as any },
    req,
    dt,
  );
  assert.deepEqual(plan.sections.map((s) => s.id), dt.sections.map((s) => s.id));
  assert.equal(plan.sections[1].heading, "The Problem");
  const total = plan.sections.reduce((a, s) => a + s.questions.length, 0);
  assert.equal(total, 4);
  for (const s of plan.sections) {
    const research = dt.sections.find((t) => t.id === s.id)!.research;
    if (!research) assert.equal(s.questions.length, 0);
    else assert.ok(s.questions.length >= 1);
  }
});

test("supervisor routes through plan → research → write → review → revise → finish", () => {
  const request = defaultRequest({ topic: "t", maxRevisions: 1 });
  const plan: Plan = { title: "T", summary: "", sections: [{ id: "a", heading: "A", goal: "", questions: ["q"] }] };
  const base = { request, plan: null, tasks: [], findings: [], review: null, iteration: 0, draftIteration: -1, reviewIteration: -1 };
  assert.equal(decide(base).next, "plan");
  const tasks = [{ id: "a-q1", sectionId: "a", question: "q", status: "pending" as const, round: 0 }];
  assert.equal(decide({ ...base, plan, tasks }).next, "research");
  const done = [{ ...tasks[0], status: "done" as const }];
  assert.equal(decide({ ...base, plan, tasks: done }).next, "write");
  assert.equal(decide({ ...base, plan, tasks: done, draftIteration: 0 }).next, "review");

  const failing: Review = { iteration: 0, score: 5, passes: false, summary: "", sectionFeedback: [], gapQuestions: [{ sectionId: "a", question: "Need data?" }, { sectionId: "a", question: "q" }] };
  const d = decide({ ...base, plan, tasks: done, draftIteration: 0, reviewIteration: 0, review: failing });
  assert.equal(d.next, "research");
  assert.equal(d.iteration, 1);
  assert.equal(d.newTasks!.length, 1, "duplicate gap question is skipped");

  const exhausted = decide({ ...base, plan, tasks: done, draftIteration: 1, reviewIteration: 1, iteration: 1, review: { ...failing, iteration: 1 } });
  assert.equal(exhausted.next, "finish");
  const passed = decide({ ...base, plan, tasks: done, draftIteration: 0, reviewIteration: 0, review: { ...failing, score: 9, passes: true } });
  assert.equal(passed.next, "finish");
});

test("revision rounds only rewrite sections with feedback or new evidence", () => {
  const plan: Plan = { title: "T", summary: "", sections: ["a", "b", "c"].map((id) => ({ id, heading: id, goal: "", questions: [] })) };
  const review: Review = { iteration: 0, score: 5, passes: false, summary: "", sectionFeedback: [{ sectionId: "b", feedback: "x" }], gapQuestions: [] };
  const tasks = [{ id: "r1-q1", sectionId: "c", question: "q", status: "done" as const, round: 1 }];
  const findings = [{ id: "r1-q1", taskId: "r1-q1", sectionId: "c", question: "q", rawNotes: "", rawSources: [], ms: 0 }];
  assert.deepEqual(sectionsToWrite(plan, 0, null, [], []), ["a", "b", "c"]);
  assert.deepEqual(sectionsToWrite(plan, 1, review, findings, tasks), ["b", "c"]);
});

test("reviewer lint flags uncited evidence sections", () => {
  const dt = getDocType("research-report");
  const long = "word ".repeat(60);
  const issues = lintSections(dt, [
    { sectionId: "findings", heading: "Key Findings", body: long, iteration: 0 },
    { sectionId: "summary", heading: "Summary", body: long, iteration: 0 },
    { sectionId: "analysis", heading: "Analysis", body: `${long} [1]`, iteration: 0 },
  ]);
  assert.deepEqual(issues.map((i) => i.sectionId), ["findings"]);
});

test("local corpus BM25 retrieval ranks the relevant chunk first", () => {
  const c = new LocalCorpus();
  c.add("a.md", 0, "Solid-state batteries use a solid electrolyte instead of liquid.");
  c.add("b.md", 0, "Urban heat islands raise city temperatures through asphalt and concrete.");
  c.add("c.md", 0, "Coffee consumption trends in Europe.");
  c.finish();
  const hits = c.search("what electrolyte do solid-state batteries use", 2, 0.1);
  assert.equal(hits[0].chunk.file, "a.md");
});
