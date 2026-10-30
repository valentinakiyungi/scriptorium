import { insertGroundingMarkers } from "../citations.ts";
import type { DocType } from "../doctypes.ts";
import type { LocalCorpus } from "../local-docs.ts";
import type { LLM } from "../llm/types.ts";
import type { DraftRequest, Finding, RawSource, ResearchTask } from "../types.ts";

export const RESEARCHER_SYSTEM = `You are a Researcher agent. Answer one research question with dense, factual notes.
- Prefer concrete facts: numbers, dates, names, study results, official positions.
- Note disagreements or uncertainty explicitly.
- 120-250 words, as short bullet points. No introduction, no conclusion.
- Never invent statistics. If evidence is thin, say so.`;

export async function research(
  llm: LLM,
  task: ResearchTask,
  req: DraftRequest,
  docType: DocType,
  corpus?: LocalCorpus,
): Promise<Finding> {
  const started = Date.now();
  const hits = corpus?.size ? corpus.search(`${task.question} ${req.topic}`, 3) : [];
  const localBlock = hits.length
    ? `\n\nLocal documents you may also use. Cite them with their marker, e.g. [[L1]]:\n` +
      hits.map((h, i) => `[[L${i + 1}]] (${h.chunk.file})\n${h.chunk.text.slice(0, 1500)}`).join("\n\n")
    : "";

  const prompt = `Topic of the overall ${docType.label}: ${req.topic}
Research question: <question>${task.question}</question>${localBlock}`;

  let notes = "";
  let rawSources: RawSource[] = [];
  let queries: string[] = [];

  if (req.web) {
    const res = await llm.search({ purpose: "research", system: RESEARCHER_SYSTEM, prompt });
    notes = insertGroundingMarkers(res.text, res.supports);
    rawSources = res.chunks.map((c) => ({ url: c.uri, title: c.title, kind: "web" as const }));
    queries = res.queries;
  } else {
    const system = hits.length
      ? `${RESEARCHER_SYSTEM}\n- Use ONLY the local documents provided. Cite every fact with its [[Lk]] marker.`
      : `${RESEARCHER_SYSTEM}\n- No sources are available: rely on well-established knowledge and flag anything uncertain.`;
    notes = await llm.text({ purpose: "research", system, prompt, temperature: 0.2 });
  }

  // Map local-document markers onto indices after the web sources.
  const offset = rawSources.length;
  const usedLocal = new Set<number>();
  notes = notes.replace(/\[\[L(\d+)\]\]/g, (_, n) => {
    const i = Number(n) - 1;
    if (!hits[i]) return "";
    usedLocal.add(i);
    return `[[${offset + i}]]`;
  });
  hits.forEach((h) =>
    rawSources.push({ url: `local://${encodeURI(h.chunk.file)}#chunk-${h.chunk.index + 1}`, title: h.chunk.file, kind: "local" }),
  );

  rawSources = await resolveRedirects(rawSources);

  return {
    id: task.id,
    taskId: task.id,
    sectionId: task.sectionId,
    question: task.question,
    rawNotes: notes.trim(),
    rawSources,
    searchQueries: queries,
    ms: Date.now() - started,
  };
}

/**
 * Gemini grounding returns vertexaisearch redirect links. Resolve them to the publisher URL
 * (best effort, short timeout) so citations are readable and de-duplicate across researchers.
 */
export async function resolveRedirects(sources: RawSource[]): Promise<RawSource[]> {
  if (process.env.SCRIPTORIUM_RESOLVE_URLS === "0") return sources;
  return Promise.all(
    sources.map(async (s) => {
      if (s.kind !== "web" || !/grounding-api-redirect|vertexaisearch\.cloud\.google\.com/.test(s.url)) return s;
      try {
        const r = await fetch(s.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
        const loc = r.headers.get("location");
        await r.body?.cancel().catch(() => {});
        return loc ? { ...s, url: loc } : s;
      } catch {
        return s;
      }
    }),
  );
}
