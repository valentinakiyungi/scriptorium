import type { DocType } from "../doctypes.ts";
import type { LLM } from "../llm/types.ts";
import type { DraftRequest, Plan, SectionPlan } from "../types.ts";

const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    title: { type: "STRING" },
    summary: { type: "STRING", description: "One sentence describing the document's angle." },
    sections: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "STRING" },
          heading: { type: "STRING" },
          goal: { type: "STRING" },
          questions: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["id", "heading", "goal", "questions"],
      },
    },
  },
  required: ["title", "summary", "sections"],
};

export const PLANNER_SYSTEM = `You are the Planner agent in a research-and-drafting team.
You turn a topic into a document outline and a set of sharp, searchable research questions.
Good research questions are specific, factual and answerable from public sources (who/what/how much/when),
not vague ("tell me about X"). Avoid overlapping questions.`;

export async function planDocument(llm: LLM, req: DraftRequest, docType: DocType): Promise<Plan> {
  const template = docType.sections.map((s) => ({ id: s.id, heading: s.heading, goal: s.goal, needsResearch: s.research }));
  const prompt = `Create the outline for a ${docType.label}.

<topic>${req.topic}</topic>
<audience>${req.audience || docType.defaultAudience}</audience>
<instructions>${req.instructions || "none"}</instructions>
<max_questions>${req.maxQuestions}</max_questions>
<sections>${JSON.stringify(template)}</sections>

Rules:
- Keep exactly these section ids, in this order. You may tailor each heading and goal to the topic.
- Write research questions only for sections with needsResearch=true: 1-3 each, at most ${req.maxQuestions} in total.
- Sections with needsResearch=false get an empty questions array.
- The title should be specific to the topic, not generic.`;

  const raw = await llm.json<Plan>({ purpose: "plan", system: PLANNER_SYSTEM, prompt, schema: PLAN_SCHEMA, temperature: 0.3 });
  return normalizePlan(raw, req, docType);
}

/** Force the model's outline back onto the template and enforce the question budget. */
export function normalizePlan(raw: Partial<Plan> | undefined, req: DraftRequest, docType: DocType): Plan {
  const got = new Map((raw?.sections ?? []).map((s) => [s?.id, s]));
  const sections: SectionPlan[] = docType.sections.map((t) => {
    const m = got.get(t.id);
    const questions = (m?.questions ?? [])
      .map((q) => String(q).trim())
      .filter((q) => q.length > 8);
    return {
      id: t.id,
      heading: (m?.heading || t.heading).trim(),
      goal: (m?.goal || t.goal).trim(),
      questions: t.research ? [...new Set(questions)].slice(0, 3) : [],
    };
  });

  // Every research section gets at least one question.
  for (const sec of sections) {
    const t = docType.sections.find((x) => x.id === sec.id)!;
    if (t.research && sec.questions.length === 0) sec.questions.push(`${sec.heading}: ${req.topic} — key facts, figures and recent developments`);
  }

  // Trim round-robin to the global budget so every section keeps its best question.
  const budget = Math.max(1, req.maxQuestions);
  const total = () => sections.reduce((a, s) => a + s.questions.length, 0);
  while (total() > budget) {
    const longest = sections.reduce((a, b) => (b.questions.length > a.questions.length ? b : a));
    if (longest.questions.length <= 1) {
      // Still over budget with one each: drop from the end.
      const last = [...sections].reverse().find((s) => s.questions.length > 0)!;
      last.questions.pop();
    } else longest.questions.pop();
  }

  return {
    title: (raw?.title || `${docType.label}: ${req.topic}`).trim(),
    summary: (raw?.summary || "").trim(),
    sections,
  };
}
