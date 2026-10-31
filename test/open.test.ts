import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { OpenResearchLLM, questionFor, rebuildAbstract, sentences } from "../src/llm/open.ts";
import { defaultRequest, runPipeline } from "../src/pipeline.ts";

// Fake Wikipedia + OpenAlex endpoints returning their documented response shapes.
let openAlexStatus = 200;
const hits: string[] = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, "http://x");
  hits.push(u.pathname + u.search);
  res.setHeader("content-type", "application/json");
  if (u.pathname === "/w/api.php") {
    const q = u.searchParams.get("gsrsearch") ?? "";
    return res.end(
      JSON.stringify({
        query: {
          pages: [
            {
              pageid: 1, index: 1, title: "Digital literacy", fullurl: "https://en.wikipedia.org/wiki/Digital_literacy",
              extract: `Digital literacy is an individual's ability to find, evaluate, and communicate information using digital technology. In 2023, around 33% of adults in the EU lacked basic digital skills according to Eurostat. It is widely studied.`,
            },
            {
              pageid: 2, index: 2, title: "Adult education", fullurl: "https://en.wikipedia.org/wiki/Adult_education",
              extract: `Adult education is a practice in which adults engage in systematic learning to gain new forms of knowledge. Community programmes for adult digital literacy often run in public libraries. Query was ${q}.`,
            },
          ],
        },
      }),
    );
  }
  if (u.pathname === "/works") {
    if (openAlexStatus !== 200) {
      res.statusCode = openAlexStatus;
      return res.end(JSON.stringify({ error: "limit" }));
    }
    return res.end(
      JSON.stringify({
        results: [
          {
            id: "https://openalex.org/W1", doi: "https://doi.org/10.1000/dl.2021.7", title: "Evaluating community digital literacy programmes", publication_year: 2021,
            primary_location: { source: { display_name: "Computers & Education" } },
            abstract_inverted_index: { "Community": [0], "digital": [1], "literacy": [2], "programmes": [3], "improved": [4], "adult": [5], "learners'": [6], "confidence": [7], "by": [8], "40%": [9], "in": [10], "a": [11], "2021": [12], "trial.": [13] },
          },
        ],
      }),
    );
  }
  res.statusCode = 404;
  res.end("{}");
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  process.env.SCRIPTORIUM_WIKI_BASE = `http://127.0.0.1:${port}/w/api.php`;
  process.env.SCRIPTORIUM_OPENALEX_BASE = `http://127.0.0.1:${port}`;
});
after(() => server.close());

test("helpers: abstracts, sentences and section questions", () => {
  assert.equal(rebuildAbstract({ world: [1], Hello: [0] }), "Hello world");
  assert.deepEqual(sentences("Short. A complete sentence that is long enough to keep as a quote. It refers back to something."), ["A complete sentence that is long enough to keep as a quote."]);
  const q = questionFor("Key Findings", "evidence with figures", "adult digital literacy");
  assert.equal(q.question, "What do studies and data show about adult digital literacy?");
  assert.equal(q.query, "adult digital literacy study");
  assert.match(q.focus, /percent/);
  assert.match(questionFor("Analysis", "trade-offs", "x").focus, /barrier/);
  // Goals that mention other sections don't hijack the match.
  assert.match(questionFor("Analysis", "What explains the findings; trade-offs", "x").question, /challenges/);
  assert.match(questionFor("Implications & Recommendations", "What the findings mean", "x").question, /policies/);
});

test("free mode drafts a document citing only real sources it retrieved", async () => {
  openAlexStatus = 200;
  const llm = new OpenResearchLLM();
  const r = await runPipeline(defaultRequest({ topic: "a community programme to improve adult digital literacy", docType: "research-report", maxRevisions: 0, maxQuestions: 4 }), { llm });

  assert.equal(r.title, "A community programme to improve adult digital literacy");
  const urls = r.references.map((x) => x.url);
  assert.ok(urls.includes("https://en.wikipedia.org/wiki/Digital_literacy"));
  assert.ok(urls.includes("https://doi.org/10.1000/dl.2021.7"), "scholarly paper cited by DOI");
  assert.ok(!urls.some((u) => /example\.(org|gov|edu)/.test(u)), "no placeholder sources");
  assert.ok(r.references.find((x) => x.url.includes("doi.org"))!.title.includes("(2021) — Computers & Education"));

  // Quoted text really comes from the sources, and every citation resolves to a reference.
  assert.match(r.markdown, /around 33% of adults in the EU lacked basic digital skills/);
  assert.match(r.markdown, /Free mode: this draft is assembled from sentences quoted/);
  const ids = new Set(r.references.map((x) => x.id));
  for (const m of r.markdown.matchAll(/\[(\d+)\](?!\()/g)) assert.ok(ids.has(Number(m[1])));
  // No sentence is repeated within a section.
  for (const sec of r.markdown.split(/^## /m)) {
    const lines = sec.split(/(?<=\.)\s|\n/).map((l) => l.replace(/\[\d+\]/g, "").trim()).filter((l) => l.length > 40);
    assert.equal(new Set(lines).size, lines.length);
  }
  assert.ok(r.metrics.finalScore! >= 7);
  assert.ok(hits.some((h) => h.includes("origin=*")), "Wikipedia requests are CORS-enabled");
});

test("OpenAlex limits degrade gracefully to Wikipedia only", async () => {
  openAlexStatus = 409;
  const llm = new OpenResearchLLM();
  const notices: string[] = [];
  const r = await runPipeline(defaultRequest({ topic: "adult digital literacy", docType: "policy-memo", maxRevisions: 0, maxQuestions: 3 }), {
    llm,
    onEvent: (e) => { if (e.type === "trace" && e.event.agent === "gemini") notices.push(e.event.message); },
  });
  assert.ok(r.references.length > 0);
  assert.ok(r.references.every((x) => x.url.includes("wikipedia.org")));
  assert.equal(notices.filter((n) => /OpenAlex/.test(n)).length, 1);
  openAlexStatus = 200;
});
