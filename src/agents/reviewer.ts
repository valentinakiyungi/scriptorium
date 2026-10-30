import { countCitations } from "../citations.ts";
import type { DocType } from "../doctypes.ts";
import type { LLM } from "../llm/types.ts";
import type { DraftRequest, Plan, Review, SectionDraft, Source } from "../types.ts";

const REVIEW_SCHEMA = {
  type: "OBJECT",
  properties: {
    score: { type: "INTEGER", description: "Overall quality 1-10." },
    summary: { type: "STRING" },
    sectionFeedback: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { sectionId: { type: "STRING" }, feedback: { type: "STRING" } },
        required: ["sectionId", "feedback"],
      },
    },
    gapQuestions: {
      type: "ARRAY",
      description: "Research questions that would fill real evidence gaps. Empty if none.",
      items: {
        type: "OBJECT",
        properties: { sectionId: { type: "STRING" }, question: { type: "STRING" } },
        required: ["sectionId", "question"],
      },
    },
  },
  required: ["score", "summary", "sectionFeedback", "gapQuestions"],
};

export const REVIEWER_SYSTEM = `You are the Reviewer agent: a demanding editor and fact-checker.
Score the draft 1-10 against the rubric. 8+ means ready to share with the stated audience.
Give specific, actionable feedback per section (only for sections that need changes).
Propose gap research questions ONLY where a missing fact materially weakens the document (max 4).`;

export interface ReviewInput {
  request: DraftRequest;
  plan: Plan;
  sections: SectionDraft[];
  sources: Source[];
  iteration: number;
  passScore: number;
}

/** Deterministic checks that run regardless of the model's judgement. */
export function lintSections(docType: DocType, sections: SectionDraft[]): { sectionId: string; feedback: string }[] {
  const issues: { sectionId: string; feedback: string }[] = [];
  for (const sec of sections) {
    const t = docType.sections.find((s) => s.id === sec.sectionId);
    const words = sec.body.split(/\s+/).filter(Boolean).length;
    if (words < 40) issues.push({ sectionId: sec.sectionId, feedback: `Section is too thin (${words} words); expand with evidence.` });
    if (t?.research && countCitations(sec.body) === 0) {
      issues.push({ sectionId: sec.sectionId, feedback: "Evidence section has no citations; support claims with [n] references." });
    }
  }
  return issues;
}

export async function reviewDocument(llm: LLM, docType: DocType, input: ReviewInput): Promise<Review> {
  const doc = input.sections.map((s) => `## ${s.heading} {#${s.sectionId}}\n\n${s.body}`).join("\n\n");
  const prompt = `Review this ${docType.label} draft (review round <iteration>${input.iteration}</iteration>).
Topic: ${input.request.topic}
Audience: ${input.request.audience || docType.defaultAudience}
Extra instructions: ${input.request.instructions || "none"}
Number of distinct sources available: ${input.sources.length}

Rubric:
${docType.rubric.map((r) => `- ${r}`).join("\n")}

Section ids: ${input.plan.sections.map((s) => s.id).join(", ")}

<draft>
${doc}
</draft>`;

  const raw = await llm.json<Omit<Review, "iteration" | "passes">>({
    purpose: "review",
    system: REVIEWER_SYSTEM,
    prompt,
    schema: REVIEW_SCHEMA,
    temperature: 0.1,
  });

  const ids = new Set(input.plan.sections.map((s) => s.id));
  const lint = lintSections(docType, input.sections);
  const sectionFeedback = [...(raw.sectionFeedback ?? []).filter((f) => ids.has(f.sectionId)), ...lint];
  let score = Math.max(1, Math.min(10, Math.round(Number(raw.score) || 1)));
  // Hard quality gate: uncited evidence sections cap the score.
  if (lint.some((l) => l.feedback.includes("no citations")) && input.request.web) score = Math.min(score, input.passScore - 1);

  return {
    iteration: input.iteration,
    score,
    passes: score >= input.passScore,
    summary: raw.summary ?? "",
    sectionFeedback,
    gapQuestions: (raw.gapQuestions ?? []).filter((g) => ids.has(g.sectionId) && g.question?.trim()).slice(0, 4),
  };
}
