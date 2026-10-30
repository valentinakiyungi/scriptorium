# ✒ Scriptorium

**Autonomous multi-agent research & document drafting.**
Give Scriptorium a topic and a document type; a team of AI agents researches it on the live web, drafts every section in parallel, fact-checks itself, and hands you a structured, citation-backed document.

Built with **LangGraph** (Supervisor-Worker orchestration) and **Google Gemini** (with Google Search grounding).

> *A scriptorium was the room in a medieval monastery where scholars researched, drafted and copied manuscripts — a team producing documents together. This project is the same idea with agents.*

---

## What it does

```
                         ┌──────────────┐
           ┌────────────►│  SUPERVISOR  │◄───────────────────────────┐
           │             └──────┬───────┘                            │
           │      decides who works next & when the document is done │
           │    ┌───────────────┼────────────────┬─────────────┐     │
           │    ▼               ▼                ▼             ▼     │
           │ PLANNER      RESEARCHER × N     WRITER × M     REVIEWER │
           │ outline +    (parallel, Gemini  (parallel,     scores vs │
           │ questions     + Google Search   one per        rubric,   │
           │    │          + local docs)     section)       finds gaps│
           │    │               │                │             │     │
           └────┘               ▼                ▼             └─────┘
                            COLLATOR         ASSEMBLER
                         dedupe sources,   order sections, validate
                         global citation   & renumber citations,
                              ids          build references
                                │                │
                                └──► SUPERVISOR ◄┘
```

1. **Supervisor** — a deterministic, auditable router over the shared graph state. It dispatches workers, fans out parallel jobs with LangGraph's `Send` API, and decides whether a draft passes or needs another round.
2. **Planner** — turns the topic into an outline tailored to the chosen document type, plus a budgeted set of sharp research questions.
3. **Researchers (parallel)** — one per question. Each calls Gemini with **Google Search grounding**, then converts Gemini's grounding metadata into precise inline citations. Optional local `.md`/`.txt` files are searched with BM25 and cited too.
4. **Collator** — merges every researcher's sources into one de-duplicated registry (tracking params stripped, redirect links resolved) with stable global ids.
5. **Writers (parallel)** — one per section, each given its own evidence first, the outline, the voice of the document type and a word budget. Revision rounds rewrite only the sections that got feedback or new evidence.
6. **Assembler** — orders sections, **drops any citation that doesn't match a real source**, renumbers citations by first appearance and generates the reference list.
7. **Reviewer** — scores the draft 1-10 against the document type's rubric, gives section-level feedback, proposes gap-filling research questions, and enforces hard checks (e.g. evidence sections must be cited). Below the pass bar, the supervisor loops back: research the gaps → revise → review.

### Document types

| id | Type | Sections |
|---|---|---|
| `research-report` | Research Report | Executive Summary · Background · Key Findings · Analysis · Implications · Conclusion |
| `literature-review` | Literature Review | Scope · Major Themes · Debates · Methodological Trends · Research Gaps · Conclusion |
| `executive-brief` | Executive Brief | Bottom Line · Situation · Options · Recommendation & Next Steps |
| `policy-memo` | Policy Memo | Summary · Problem · Policy Landscape · Options · Recommendation |
| `technical-whitepaper` | Technical Whitepaper | Abstract · Problem · Approach · Evaluation · Trade-offs · Adoption |
| `blog-article` | Blog Article | Introduction · Explainer · Evidence · Perspectives · Takeaways |
| `grant-proposal` | Grant Proposal | Summary · Need · Aims · Methods · Impact & Evaluation · Budget & Timeline |

Each type carries its own tone, length target and review rubric — add your own in [`src/doctypes.ts`](src/doctypes.ts).

---

## Quick start

**Requirements:** Node.js 20+ and a free Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
git clone https://github.com/valentinakiyungi/scriptorium.git
cd scriptorium
npm install
cp .env.example .env        # then paste your key into GEMINI_API_KEY
```

### Web app

```bash
npm run web                 # http://localhost:3000
```

- **No `.env` editing needed** — click the settings button, paste your Gemini key, hit *Test connection*, then *Save*.
- Pick a document type chip, type a topic (or click a suggested one) and press **Draft** (`⌘/Ctrl + Enter`).
- **Reference sources** — attach files, URLs or pasted text; researchers search and cite them alongside the web.
- Watch the **Agent team** card light up each agent, follow every supervisor decision in **Activity**, and see the reviewer's scorecard under **Quality**. Press **Stop** to cancel a run.
- Switch between the **Document**, **Outline** and **Evidence** views; copy Markdown, download `.md`/`.html`, or print to PDF.
- Light/dark theme, works on mobile, and every finished document is saved under **History**.

### Command line

```bash
npm run draft -- "The economics of offshore wind in Northern Europe" --type policy-memo
npm run draft -- "RAG for enterprise search" -t technical-whitepaper -a "CTOs" -i "Focus on cost"
npm run types               # list document types
```

Every run writes `output/<timestamp>-<slug>/document.md` and a full `run.json` (plan, findings, sources, reviews, agent trace, token usage, timings).

| Option | Default | |
|---|---|---|
| `-t, --type` | `research-report` | Document type id |
| `-a, --audience` | per type | Who it's for |
| `-i, --instructions` | – | Extra guidance |
| `-q, --max-questions` | `8` | Research questions in the plan |
| `-r, --max-revisions` | `1` | Reviewer-driven revision rounds |
| `--no-web` | – | Use only local documents in `./data` |
| `--data <dir>` | `./data` | Local corpus folder |
| `--mock` | – | Offline demo, no API key needed |

Install globally with `npm link`, then just run `scriptorium draft "…"`.

### Try it without an API key

```bash
npm run demo                # web app with the offline mock model
npm run draft -- "anything" --mock
```

---

## Benchmark

```bash
npm run bench                       # one task per document type (7 runs)
npm run bench -- --baseline 180     # also compute time saved vs. your measured manual minutes/doc
```

Writes `output/benchmark-*.json` with time, words, references, citations, reviewer score, LLM calls and tokens for each task. With `--baseline`, it reports time saved assuming a 15-minute human review of each AI draft.

---

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `GEMINI_API_KEY` | – | Required (except `--mock`) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Planner, writers, reviewer |
| `GEMINI_RESEARCH_MODEL` | same | Researchers (e.g. a cheaper Flash-Lite) |
| `SCRIPTORIUM_CONCURRENCY` | `4` | Max simultaneous Gemini calls — lower if you hit 429s |
| `SCRIPTORIUM_PASS_SCORE` | `8` | Reviewer score that ends the loop |
| `SCRIPTORIUM_DATA_DIR` | `./data` | Local corpus |
| `SCRIPTORIUM_OUTPUT_DIR` | `./output` | Where documents are saved |
| `PORT` | `3000` | Web app port |

---

## Project structure

```
scriptorium/
├── src/
│   ├── graph.ts            # LangGraph state, Supervisor-Worker wiring, Send fan-outs
│   ├── run.ts              # Runs a job, streams events, computes metrics, saves output
│   ├── agents/
│   │   ├── supervisor.ts   # Routing policy (plan → research → write → review → revise/finish)
│   │   ├── planner.ts      # Outline + research questions
│   │   ├── researcher.ts   # Grounded web + local research with citations
│   │   ├── writer.ts       # Section drafting / revision
│   │   └── reviewer.ts     # Rubric scoring, gap detection, lint checks
│   ├── citations.ts        # Grounding → markers, source de-dup, validation, renumbering
│   ├── doctypes.ts         # 7 document templates with rubrics
│   ├── local-docs.ts       # BM25 search over ./data
│   ├── llm/                # Gemini REST client (retries, concurrency, JSON mode) + offline mock
│   ├── cli.ts · server.ts · bench.ts
├── public/index.html       # Web app (no build step, no CDN dependencies)
├── test/                   # node:test suite — unit + end-to-end pipeline tests
└── data/                   # Your optional local documents
```

## Development

```bash
npm test                    # 15 tests, run offline with the mock model
npm run typecheck
```

## License

MIT
