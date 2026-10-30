#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadEnv, settings } from "./config.ts";
import { DOC_TYPES } from "./doctypes.ts";
import { createLLM } from "./llm/index.ts";
import { defaultRequest, runScriptorium, type RunEvent } from "./run.ts";

loadEnv();

const HELP = `
Scriptorium — autonomous multi-agent research & document drafting

Usage
  scriptorium draft "<topic>" [options]   Research a topic and draft a cited document
  scriptorium types                       List available document types
  scriptorium web [--port 3000]           Start the web app
  scriptorium bench [--mock]              Run the benchmark suite (one task per doc type)

Draft options
  -t, --type <id>            Document type (default: research-report)
  -a, --audience <text>      Who the document is for
  -i, --instructions <text>  Extra guidance (tone, focus, constraints)
  -q, --max-questions <n>    Research questions in the initial plan (default: 6)
  -r, --max-revisions <n>    Reviewer-driven revision rounds (default: 1)
      --no-web               Skip Google Search; use local documents in ./data only
      --data <dir>           Folder of .md/.txt files to include as sources
  -o, --out <dir>            Output folder (default: ./output)
      --mock                 Offline demo mode (no API key needed)
      --quiet                Only print the output path
  -h, --help                 Show this help
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "help";
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    options: {
      type: { type: "string", short: "t" },
      audience: { type: "string", short: "a" },
      instructions: { type: "string", short: "i" },
      "max-questions": { type: "string", short: "q" },
      "max-revisions": { type: "string", short: "r" },
      "no-web": { type: "boolean" },
      data: { type: "string" },
      out: { type: "string", short: "o" },
      mock: { type: "boolean" },
      quiet: { type: "boolean" },
      port: { type: "string", short: "p" },
      baseline: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || cmd === "help") return console.log(HELP);

  if (cmd === "types") {
    for (const d of DOC_TYPES) {
      console.log(`${d.id.padEnd(22)} ${d.label} — ${d.description}`);
      console.log(`${"".padEnd(22)} sections: ${d.sections.map((s) => s.heading).join(" · ")}\n`);
    }
    return;
  }

  if (cmd === "web") {
    const { startServer } = await import("./server.ts");
    await startServer({ port: Number(values.port || settings().port), mock: !!values.mock });
    return;
  }

  if (cmd === "bench") {
    const { runBenchmark } = await import("./bench.ts");
    await runBenchmark({ mock: !!values.mock, baselineMinutes: values.baseline ? Number(values.baseline) : undefined, out: values.out });
    return;
  }

  if (cmd !== "draft") {
    console.error(`Unknown command "${cmd}".\n${HELP}`);
    process.exit(1);
  }

  const topic = positionals.join(" ").trim();
  if (!topic) {
    console.error('Please provide a topic, e.g. scriptorium draft "solid-state batteries" --type technical-whitepaper');
    process.exit(1);
  }

  const request = defaultRequest({
    topic,
    docType: values.type ?? "research-report",
    audience: values.audience,
    instructions: values.instructions,
    maxQuestions: values["max-questions"] ? Number(values["max-questions"]) : 6,
    maxRevisions: values["max-revisions"] ? Number(values["max-revisions"]) : 1,
    web: !values["no-web"],
    dataDir: values.data,
  });

  const llm = createLLM({ mock: values.mock });
  const quiet = !!values.quiet;
  const color = process.stdout.isTTY ? (c: number, s: string) => `\x1b[${c}m${s}\x1b[0m` : (_: number, s: string) => s;
  const agentColor: Record<string, number> = { supervisor: 35, planner: 36, researcher: 34, collator: 90, writer: 32, assembler: 90, reviewer: 33 };

  const onEvent = (e: RunEvent) => {
    if (quiet) return;
    if (e.type === "start") {
      console.log(color(1, `\n✒  Scriptorium — ${e.request.docType} on "${e.request.topic}"`));
      console.log(color(90, `   model ${e.model} · web ${e.request.web ? "on" : "off"} · local chunks ${e.localChunks}\n`));
    } else if (e.type === "trace") {
      const a = e.event.agent;
      console.log(`${color(agentColor[a] ?? 37, a.padEnd(10))} ${e.event.message}${e.event.ms > 50 ? color(90, ` (${(e.event.ms / 1000).toFixed(1)}s)`) : ""}`);
    }
  };

  const result = await runScriptorium(request, { llm, onEvent, outputDir: values.out });
  const m = result.metrics;
  if (quiet) return console.log(result.outputDir);
  console.log(color(1, `\n✔ ${result.title}`));
  console.log(
    `  ${m.words} words · ${m.citedReferences} references · ${m.citations} citations · score ${m.finalScore ?? "–"}/10 · ` +
      `${m.revisions} revision(s) · ${m.llmCalls} LLM calls · ${(m.totalMs / 1000).toFixed(1)}s`,
  );
  console.log(`  Saved to ${result.outputDir}/document.md\n`);
}

main().catch((e) => {
  console.error(`\n✖ ${e?.message ?? e}`);
  process.exit(1);
});
