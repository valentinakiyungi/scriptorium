// Free, keyless research provider. Real sources, no AI model:
//   • Researchers search Wikipedia (intro extracts) and OpenAlex (scholarly abstracts) and keep the
//     sentences most relevant to each question, each tied to its real source URL.
//   • Writers assemble sections from those quoted sentences — nothing is invented.
//   • The reviewer runs deterministic citation checks.
// Plugs into the same LangGraph pipeline through the LLM interface. Works in browsers (both APIs
// allow anonymous cross-origin requests) and in Node.
import { tokenize } from "../local-docs.ts";
import type { Usage } from "../types.ts";
import type { GroundedResult, GroundingChunk, GroundingSupport, JsonRequest, LLM, TextRequest } from "./types.ts";

const env = (k: string): string | undefined => (globalThis as any).process?.env?.[k] ?? (globalThis as any)[k];
const wikiBase = () => env("SCRIPTORIUM_WIKI_BASE") || "https://en.wikipedia.org/w/api.php";
const openAlexBase = () => env("SCRIPTORIUM_OPENALEX_BASE") || "https://api.openalex.org";
const isNode = typeof (globalThis as any).window === "undefined";

/** OpenAlex allows ~10 keyless searches per day per visitor, so use it sparingly. */
const OPENALEX_PER_RUN = 4;

export const FREE_NOTE =
  "*Free mode: this draft is assembled from sentences quoted from the cited sources (Wikipedia and OpenAlex). Add a Gemini API key for an AI-written synthesis grounded in Google Search.*";

interface Passage {
  text: string;
  source: GroundingChunk;
}

const tag = (s: string, name: string) => s.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

export function sentenceCase(s: string): string {
  const t = s.trim().replace(/[.?!]+$/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Split prose into sentences, keeping ones that read as standalone statements. */
export function sentences(text: string): string[] {
  // Work paragraph by paragraph so headings (short lines without end punctuation) never merge into prose.
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 60 || /[.!?]$/.test(l))
    .flatMap((para) => para.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9“"(])/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 420 && /[.!?]$/.test(s) && !/^(this|it|they|these|he|she)\b/i.test(s));
}

/** Rank sentences by overlap with the query terms; focus words (the section's purpose) count double
 *  and facts with numbers get a small boost. */
export function rankSentences(cands: Passage[], query: string, limit: number, focus = ""): Passage[] {
  const q = new Set(tokenize(query));
  const f = new Set(tokenize(focus).map((w) => w.slice(0, 6)));
  const seen = new Set<string>();
  return cands
    .map((p, i) => {
      const toks = new Set(tokenize(p.text));
      let overlap = 0;
      for (const t of q) if (toks.has(t)) overlap++;
      let focusHits = 0;
      for (const t of toks) if (f.has(t.slice(0, 6))) focusHits++;
      const score = overlap + 3 * Math.min(focusHits, 2) + (/\d/.test(p.text) ? 0.5 : 0) - i * 0.001;
      return { p, score, overlap };
    })
    .filter((x) => x.overlap > 0)
    .sort((a, b) => b.score - a.score)
    .filter((x) => {
      const k = x.p.text.toLowerCase().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit)
    .map((x) => x.p);
}

/** Map a section to a research question, the search query that answers it, and focus words that
 *  pick the sentences suited to that section (e.g. barriers for Analysis, numbers for Key Findings). */
export function questionFor(heading: string, goal: string, topic: string): { question: string; query: string; focus: string } {
  const t = goal.toLowerCase();
  const T = topic.trim().replace(/[.?!]+$/, "");
  const rules: [RegExp, string, string, string][] = [
    [/background|context|introduction|scope|explainer|what's going on|situation|abstract/, `What is the background and context of ${T}?`, T, "defined refers term concept history began origin known describes"],
    [/need|problem|motivation/, `What problem does ${T} address, and how large is it?`, `${T}`, "problem lack shortage barrier percent million population affected access gap"],
    [/finding|evidence|statistic|data|themes/, `What do studies and data show about ${T}?`, `${T} study`, "study survey found percent data report research statistics increase decrease million results"],
    [/debate|contradiction|perspective|analysis|trade-?off|limitation|challenge/, `What challenges and debates surround ${T}?`, `${T} challenges`, "challenge barrier risk criticism concern limitation debate however problem difficult cost"],
    [/landscape|policy|option|recommendation|implication/, `What policies and options exist for ${T}?`, `${T} policy`, "policy government programme program initiative strategy law funding recommend public national"],
    [/method|approach|technical/, `How is ${T} approached in practice?`, `${T} methods`, "method approach training curriculum technique model framework delivered teaching"],
    [/evaluation|impact|performance|outcome/, `How are the outcomes of ${T} measured?`, `${T} evaluation`, "evaluation impact outcome measure effect result assessment improved effectiveness"],
    [/gap/, `What gaps remain in research on ${T}?`, `${T} research`, "gap unknown further research limited evidence lack unclear future"],
  ];
  // Match the heading first: goals often mention other sections ("what explains the findings").
  for (const text of [heading.toLowerCase(), t]) for (const [re, question, query, focus] of rules) if (re.test(text)) return { question, query, focus };
  return { question: `${heading}: what is known about ${T}?`, query: `${T} ${heading}`, focus: heading.toLowerCase() };
}

export class OpenResearchLLM implements LLM {
  readonly name = "free:wikipedia+openalex";
  readonly usage: Usage = { calls: 0, promptTokens: 0, outputTokens: 0 };
  onNotice?: (message: string) => void;
  private queries = new Map<string, { query: string; focus: string }>();
  private usedInDraft = new Set<string>();
  private openAlexLeft = OPENALEX_PER_RUN;
  private openAlexDown = false;

  // ── Planner + reviewer (deterministic) ────────────────────────────────────
  async json<T>(req: JsonRequest): Promise<T> {
    if (req.purpose === "plan") {
      const topic = tag(req.prompt, "topic") ?? "the topic";
      const max = Number(tag(req.prompt, "max_questions") ?? 6);
      const sections = JSON.parse(tag(req.prompt, "sections") ?? "[]") as { id: string; heading: string; goal: string; needsResearch: boolean }[];
      let budget = max;
      const out = sections.map((s) => {
        const questions: string[] = [];
        if (s.needsResearch && budget > 0) {
          const { question, query, focus } = questionFor(s.heading, s.goal, topic);
          if (![...this.queries.keys()].includes(question)) {
            this.queries.set(question, { query, focus });
            questions.push(question);
            budget--;
          }
        }
        return { id: s.id, heading: s.heading, goal: s.goal, questions };
      });
      return { title: sentenceCase(topic), summary: `What public sources say about ${topic.trim()}.`, sections: out } as T;
    }
    if (req.purpose === "review") {
      const draft = tag(req.prompt, "draft") ?? "";
      const parts = draft.split(/^## /m).slice(1);
      const cited = parts.filter((p) => /\[\d+\]/.test(p)).length;
      const ratio = parts.length ? cited / parts.length : 0;
      return {
        score: ratio >= 0.8 ? 8 : ratio >= 0.5 ? 7 : 5,
        summary: `Automated check (free mode): ${cited} of ${parts.length} sections are supported by cited sources.`,
        sectionFeedback: [],
        gapQuestions: [],
      } as T;
    }
    return {} as T;
  }

  // ── Researchers: real web sources ─────────────────────────────────────────
  async search(req: TextRequest): Promise<GroundedResult> {
    const question = tag(req.prompt, "question") ?? "";
    const topic = req.prompt.match(/^Topic of the overall [^:]+: (.+)$/m)?.[1] ?? question;
    const planned = this.queries.get(question);
    const query = planned?.query ?? question.replace(/^(what|how|why|which)\b[^a-z0-9]*/i, "").replace(/[?]/g, "");
    const focus = planned?.focus ?? question;

    const [wiki, papers] = await Promise.all([this.wikipedia(query), this.openAlex(query)]);
    const local = localPassages(req.prompt);
    const chunks: GroundingChunk[] = [];
    const candidates: Passage[] = [];
    for (const p of [...wiki, ...papers]) candidates.push(p);
    const picked = rankSentences(candidates, `${question} ${topic}`, 6, focus);

    let text = "";
    const supports: GroundingSupport[] = [];
    const enc = new TextEncoder();
    for (const p of picked) {
      let idx = chunks.findIndex((c) => c.uri === p.source.uri);
      if (idx === -1) idx = chunks.push(p.source) - 1;
      const line = `${text ? "\n" : ""}- ${p.text}`;
      const start = enc.encode(text).length;
      text += line;
      supports.push({ startIndex: start, endIndex: enc.encode(text).length, text: line, chunkIndices: [idx] });
    }
    for (const l of rankSentences(local, `${question} ${topic}`, 2)) text += `${text ? "\n" : ""}- ${l.text} ${l.source.uri}`;
    if (!text) text = `- No relevant passages were found in Wikipedia or OpenAlex for "${query}".`;
    return { text, chunks, supports, queries: [query] };
  }

  private async getJson(url: string): Promise<any> {
    this.usage.calls++;
    const headers: Record<string, string> = { accept: "application/json" };
    if (isNode) headers["user-agent"] = "Scriptorium/1.0 (https://github.com/valentinakiyungi/scriptorium)";
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return r.json();
  }

  private async wikipedia(query: string): Promise<Passage[]> {
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", origin: "*",
      generator: "search", gsrsearch: query, gsrlimit: "3",
      prop: "extracts|info", exintro: "1", explaintext: "1", exlimit: "3", inprop: "url",
    });
    try {
      const d = await this.getJson(`${wikiBase()}?${params}`);
      const pages: any[] = (d?.query?.pages ?? []).sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
      const src = (p: any) => ({ uri: p.fullurl ?? `https://en.wikipedia.org/?curid=${p.pageid}`, title: `${p.title} — Wikipedia` });
      const out: Passage[] = pages.flatMap((p) => sentences(p.extract ?? "").map((text) => ({ text, source: src(p) })));
      // Intros are short: also read the full text of the best match so each section finds its own material.
      const top = pages[0];
      if (top?.pageid) {
        try {
          const full = await this.getJson(
            `${wikiBase()}?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", origin: "*", prop: "extracts", explaintext: "1", exsectionformat: "plain", pageids: String(top.pageid) })}`,
          );
          const body: string = (full?.query?.pages?.[0]?.extract ?? "").slice(0, 30_000).split(/\n\s*(See also|References|External links|Further reading|Notes)\s*\n/)[0];
          const intro = new Set(out.map((x) => x.text));
          for (const text of sentences(body)) if (!intro.has(text)) out.push({ text, source: src(top) });
        } catch {
          /* intro sentences are still usable */
        }
      }
      return out;
    } catch {
      this.onNotice?.("Wikipedia didn't respond for one question — continuing with other sources.");
      return [];
    }
  }

  private async openAlex(query: string): Promise<Passage[]> {
    if (this.openAlexDown || this.openAlexLeft <= 0) return [];
    this.openAlexLeft--;
    const params = new URLSearchParams({ search: query, "per-page": "3", filter: "has_abstract:true" });
    const key = env("OPENALEX_API_KEY");
    if (key) params.set("api_key", key);
    try {
      const d = await this.getJson(`${openAlexBase()}/works?${params}`);
      return (d?.results ?? []).flatMap((w: any) => {
        const abstract = rebuildAbstract(w.abstract_inverted_index);
        const venue = w.primary_location?.source?.display_name;
        const source = {
          uri: w.doi || w.primary_location?.landing_page_url || w.id,
          title: `${w.title ?? w.display_name ?? "Untitled paper"}${w.publication_year ? ` (${w.publication_year})` : ""}${venue ? ` — ${venue}` : ""}`,
        };
        return sentences(abstract).map((text) => ({ text, source }));
      });
    } catch (e: any) {
      // Parallel researchers can fail together — tell the user once.
      if (this.openAlexDown) return [];
      this.openAlexDown = true;
      this.onNotice?.(
        e?.status === 409 || e?.status === 429
          ? "OpenAlex's free daily allowance is used up — continuing with Wikipedia only."
          : "OpenAlex didn't respond — continuing with Wikipedia only.",
      );
      return [];
    }
  }

  // ── Writers: assemble sections from quoted, cited sentences ───────────────
  async text(req: TextRequest): Promise<string> {
    if (req.purpose === "research") {
      // Web research turned off: quote the attached documents only.
      const question = tag(req.prompt, "question") ?? "";
      const local = rankSentences(localPassages(req.prompt), question, 5);
      return local.length ? local.map((l) => `- ${l.text} ${l.source.uri}`).join("\n") : "- No relevant passages were found in the attached documents.";
    }
    if (req.purpose !== "write") return "";
    const previous = tag(req.prompt, "previous");
    if (previous) return previous; // no model to revise with in free mode

    const isFirst = /\n- [^\n]*<-- you are writing this/.test(req.prompt.split("Outline:")[1]?.split("\n").slice(0, 2).join("\n") ?? "");
    const budget = Number(req.prompt.match(/about (\d+) words/)?.[1] ?? 200);
    const evidence = tag(req.prompt, "evidence") ?? "";
    const blocks = evidence.split(/\n(?=Q: )/);
    const own = blocks.filter((b) => /\(for this section\)/.test(b.split("\n")[0]));
    const rest = blocks.filter((b) => !own.includes(b));
    const linesOf = (bs: string[]) =>
      bs
        .flatMap((b) => b.split("\n").slice(1))
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter((l) => /\[\d+\]/.test(l) && !/^No relevant passages/.test(l));
    const keyOf = (l: string) => l.replace(/\[\d+\]/g, "").trim().toLowerCase().slice(0, 80);

    // Research sections quote their own evidence. Summary-style sections (no research of their own)
    // restate the strongest lines from the rest of the document, as an executive summary would.
    const pool = own.length ? linesOf(own) : linesOf(rest);
    const cap = own.length ? budget : Math.min(budget, 90);
    const chosen: string[] = [];
    const inSection = new Set<string>();
    let words = 0;
    // Research sections: sentences no other section has used, topping up with reused ones only to
    // reach two. Summary-style sections: the three strongest lines from the rest of the document.
    const fresh = pool.filter((l) => !this.usedInDraft.has(keyOf(l)));
    const reused = pool.filter((l) => !fresh.includes(l));
    const ordered = own.length ? [...fresh, ...reused.slice(0, Math.max(0, 2 - fresh.length))] : pool.slice(0, 3);
    for (const l of ordered) {
      const key = keyOf(l);
      if (inSection.has(key)) continue;
      inSection.add(key);
      if (own.length) this.usedInDraft.add(key);
      chosen.push(l);
      words += l.split(/\s+/).length;
      if (words >= cap || chosen.length >= 7) break;
    }

    const out: string[] = [];
    if (isFirst) out.push(FREE_NOTE);
    if (!chosen.length) {
      out.push("*No relevant passages were found in the free sources for this section. Add a Gemini API key, attach reference sources, or rephrase the topic.*");
    } else {
      out.push(chosen.slice(0, 2).join(" "));
      if (chosen.length > 2) out.push(chosen.slice(2).map((l) => `- ${l}`).join("\n"));
    }
    return out.join("\n\n");
  }
}

/** OpenAlex stores abstracts as an inverted index: {word: [positions]}. */
export function rebuildAbstract(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const words: string[] = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

/** Attached/local documents arrive in the research prompt as "[[Lk]] (file)\ntext" blocks. */
function localPassages(prompt: string): Passage[] {
  const out: Passage[] = [];
  for (const m of prompt.matchAll(/\[\[L(\d+)\]\] \(([^)]*)\)\n([\s\S]*?)(?=\n\n\[\[L\d+\]\]|$)/g)) {
    for (const text of sentences(m[3])) out.push({ text, source: { uri: `[[L${m[1]}]]`, title: m[2] } });
  }
  return out;
}
