import type { Usage } from "../types.ts";
import type { GroundedResult, JsonRequest, LLM, TextRequest } from "./types.ts";

/**
 * Deterministic offline provider. Exercises the full pipeline (planning, grounded research,
 * citations, review/revision loop) without network access or an API key.
 * Used by the test-suite and by `--mock` demo runs.
 */
export class MockLLM implements LLM {
  readonly name = "mock";
  readonly usage: Usage = { calls: 0, promptTokens: 0, outputTokens: 0 };
  /** Simulated latency per call (ms) so parallelism is observable. */
  private readonly latency: number;
  constructor(latency = 0) {
    this.latency = latency;
  }

  private async tick(prompt: string, out: string) {
    this.usage.calls++;
    this.usage.promptTokens += Math.ceil(prompt.length / 4);
    this.usage.outputTokens += Math.ceil(out.length / 4);
    if (this.latency) await new Promise((r) => setTimeout(r, this.latency));
  }

  async json<T>(req: JsonRequest): Promise<T> {
    let out: unknown;
    if (req.purpose === "plan") {
      const topic = tag(req.prompt, "topic") ?? "the topic";
      const sections = JSON.parse(tag(req.prompt, "sections") ?? "[]") as { id: string; heading: string; goal: string; needsResearch: boolean }[];
      out = {
        title: topic.charAt(0).toUpperCase() + topic.slice(1),
        summary: `A structured look at ${topic}.`,
        sections: sections.map((s) => ({
          id: s.id,
          heading: s.heading,
          goal: s.goal,
          questions: s.needsResearch
            ? [`What are the most important facts about ${s.heading.toLowerCase()} for ${topic}?`, `What recent data exists on ${s.heading.toLowerCase()} regarding ${topic}?`]
            : [],
        })),
      };
    } else if (req.purpose === "review") {
      const iteration = Number(tag(req.prompt, "iteration") ?? 0);
      const firstId = req.prompt.match(/Section ids: ([\w-]+)/)?.[1] ?? "summary";
      out =
        iteration === 0
          ? {
              score: 6,
              summary: "Solid structure, but the opening needs sharper evidence.",
              sectionFeedback: [{ sectionId: firstId, feedback: "Lead with the single most important quantified finding." }],
              gapQuestions: [{ sectionId: firstId, question: "What is the single most-cited statistic on this topic?" }],
            }
          : { score: 8, summary: "Clear, well-cited and ready to share.", sectionFeedback: [], gapQuestions: [] };
    } else {
      out = {};
    }
    const s = JSON.stringify(out);
    await this.tick(req.prompt, s);
    return out as T;
  }

  async text(req: TextRequest): Promise<string> {
    let out: string;
    if (req.purpose === "write") {
      const ids = [...(tag(req.prompt, "sources") ?? "").matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
      const heading = req.prompt.match(/<section id="[^"]*">([^<]+)<\/section>/)?.[1] ?? "Section";
      const goal = (req.prompt.match(/^Goal: (.+)$/m)?.[1] ?? "").replace(/\.$/, "");
      const questions = [...req.prompt.matchAll(/^Q: (.+?)(?: \(for this section\))?$/gm)].map((m) => m[1]).slice(0, 2);
      const revised = req.prompt.includes("<previous>");
      const c = (i: number) => (ids.length ? `[${ids[i % ids.length]}]` : "");
      out =
        `*Demo output${revised ? " (revised after review)" : ""} — with a Gemini API key, the writer agent drafts this section from live, cited web research.*\n\n` +
        `In a live run, the **${heading}** section covers: ${goal ? goal.charAt(0).toLowerCase() + goal.slice(1) : "this part of the topic"}. ` +
        `The writer receives the researchers' evidence for it and cites every claim inline ${c(0)}, drawing on several independent sources ${c(1)}.\n\n` +
        (questions.length ? `Questions the researchers answered for this document include:\n\n${questions.map((q, i) => `- ${q} ${c(i + 2)}`).join("\n")}\n\n` : "") +
        `After drafting, the assembler validates and renumbers these citations, and the reviewer scores the section against the ` +
        `document type's rubric — sending it back for revision when evidence or clarity falls short ${c(3)}.`;
    } else {
      const q = tag(req.prompt, "question") ?? "the question";
      out = `- Demo finding for: ${q}\n- Drawn from your attached documents [[L1]].`;
    }
    await this.tick(req.prompt, out);
    return out;
  }

  async search(req: TextRequest): Promise<GroundedResult> {
    const q = tag(req.prompt, "question") ?? "question";
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const s1 = `- Demo evidence for "${q.slice(0, 60)}" — a live run returns facts and figures found with Google Search.`;
    const s2 = `\n- A second, independently sourced demo point.`;
    const s3 = `\n- Live research also notes where sources disagree.`;
    const text = s1 + s2 + s3;
    const enc = new TextEncoder();
    const b = (s: string) => enc.encode(s).length;
    const res: GroundedResult = {
      text,
      chunks: [
        { uri: `https://example.org/research/${slug}`, title: "example.org (demo source)" },
        { uri: "https://stats.example.gov/annual-report", title: "stats.example.gov (demo source)" },
        { uri: "https://journal.example.edu/review?utm_source=x", title: "journal.example.edu (demo source)" },
      ],
      supports: [
        { startIndex: 0, endIndex: b(s1), text: s1, chunkIndices: [0] },
        { startIndex: b(s1), endIndex: b(s1 + s2), text: s2, chunkIndices: [1, 2] },
      ],
      queries: [q],
    };
    await this.tick(req.prompt, text);
    return res;
  }
}

function tag(s: string, name: string): string | undefined {
  return s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
}
