import type { DraftRequest, Finding, Plan, ResearchTask, Review, Route, SectionDraft } from "../types.ts";

/** The slice of graph state the supervisor reasons over. */
export interface SupervisorView {
  request: DraftRequest;
  plan: Plan | null;
  tasks: ResearchTask[];
  findings: Finding[];
  review: Review | null;
  iteration: number;
  draftIteration: number;
  reviewIteration: number;
}

export interface Decision {
  next: Route;
  reason: string;
  newTasks?: ResearchTask[];
  iteration?: number;
}

/**
 * The Supervisor's routing policy. Deterministic and auditable: the LLM workers do the
 * thinking, the supervisor decides who works next and when the document is done.
 */
export function decide(s: SupervisorView): Decision {
  if (!s.plan) return { next: "plan", reason: "No outline yet — dispatching Planner." };

  const pending = s.tasks.filter((t) => t.status === "pending");
  if (pending.length) {
    return { next: "research", reason: `${pending.length} open research question(s) — dispatching ${pending.length} Researcher(s) in parallel.` };
  }

  if (s.draftIteration !== s.iteration) {
    return {
      next: "write",
      reason: s.iteration === 0 ? "Evidence gathered — dispatching Writers for each section in parallel." : `Revision round ${s.iteration} — dispatching Writers to revise.`,
    };
  }

  if (s.reviewIteration !== s.iteration || !s.review) return { next: "review", reason: "Draft assembled — sending to Reviewer." };

  if (s.review.passes) return { next: "finish", reason: `Reviewer score ${s.review.score}/10 meets the bar — finishing.` };

  if (s.iteration >= s.request.maxRevisions) {
    return { next: "finish", reason: `Reviewer score ${s.review.score}/10, but the revision budget (${s.request.maxRevisions}) is spent — finishing.` };
  }

  // Revise: research any evidence gaps first, then rewrite.
  const iteration = s.iteration + 1;
  const asked = new Set(s.tasks.map((t) => normalize(t.question)));
  const newTasks: ResearchTask[] = [];
  for (const g of s.review.gapQuestions) {
    const key = normalize(g.question);
    if (asked.has(key)) continue;
    asked.add(key);
    newTasks.push({ id: `r${iteration}-q${newTasks.length + 1}`, sectionId: g.sectionId, question: g.question.trim(), status: "pending", round: iteration });
  }
  if (newTasks.length) {
    return {
      next: "research",
      reason: `Reviewer score ${s.review.score}/10 — researching ${newTasks.length} evidence gap(s) before revision round ${iteration}.`,
      newTasks,
      iteration,
    };
  }
  return { next: "write", reason: `Reviewer score ${s.review.score}/10 — starting revision round ${iteration}.`, iteration };
}

/** Which sections to (re)write this round. */
export function sectionsToWrite(
  plan: Plan,
  iteration: number,
  review: Review | null,
  findings: Finding[],
  tasks: ResearchTask[],
): string[] {
  const all = plan.sections.map((s) => s.id);
  if (iteration === 0 || !review) return all;
  const roundOf = new Map(tasks.map((t) => [t.id, t.round]));
  const touched = new Set<string>([
    ...review.sectionFeedback.map((f) => f.sectionId),
    ...findings.filter((f) => roundOf.get(f.taskId) === iteration).map((f) => f.sectionId),
  ]);
  const chosen = all.filter((id) => touched.has(id));
  return chosen.length ? chosen : all;
}

export function previousDraft(sections: Record<string, SectionDraft>, id: string): string | undefined {
  return sections[id]?.body;
}

function normalize(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
