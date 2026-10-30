import { Annotation, END, START, Send, StateGraph } from "@langchain/langgraph";
import { collate, renumber } from "./citations.ts";
import { getDocType } from "./doctypes.ts";
import type { LocalCorpus } from "./local-docs.ts";
import type { LLM } from "./llm/types.ts";
import { planDocument } from "./agents/planner.ts";
import { research } from "./agents/researcher.ts";
import { reviewDocument } from "./agents/reviewer.ts";
import { decide, sectionsToWrite } from "./agents/supervisor.ts";
import { writeSection } from "./agents/writer.ts";
import type {
  DraftRequest,
  Finding,
  Plan,
  ResearchTask,
  Review,
  Route,
  SectionDraft,
  Source,
  TraceEvent,
} from "./types.ts";

const replace = <T>(fallback: () => T) => Annotation<T>({ reducer: (_a: T, b: T) => b, default: fallback });
const upsertById = <T extends { id: string }>(a: T[], b: T[]): T[] => {
  const m = new Map(a.map((x) => [x.id, x]));
  for (const x of b) m.set(x.id, { ...(m.get(x.id) ?? {}), ...x });
  return [...m.values()];
};

/** Shared state for the Supervisor-Worker graph. Reducers make parallel worker writes safe. */
export const ScriptoriumState = Annotation.Root({
  request: Annotation<DraftRequest>(),
  plan: replace<Plan | null>(() => null),
  tasks: Annotation<ResearchTask[]>({ reducer: upsertById, default: () => [] }),
  findings: Annotation<Finding[]>({ reducer: upsertById, default: () => [] }),
  sources: replace<Source[]>(() => []),
  sections: Annotation<Record<string, SectionDraft>>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  assembled: replace<SectionDraft[]>(() => []),
  references: replace<Source[]>(() => []),
  document: replace<string>(() => ""),
  review: replace<Review | null>(() => null),
  reviews: Annotation<Review[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
  iteration: replace<number>(() => 0),
  draftIteration: replace<number>(() => -1),
  reviewIteration: replace<number>(() => -1),
  next: replace<Route>(() => "plan"),
  trace: Annotation<TraceEvent[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
});

export type State = typeof ScriptoriumState.State;

export interface GraphDeps {
  llm: LLM;
  corpus?: LocalCorpus;
  passScore: number;
}

const ev = (agent: string, started: number, message: string): TraceEvent => ({
  at: new Date().toISOString(),
  agent,
  ms: Date.now() - started,
  message,
});

export function buildGraph(deps: GraphDeps) {
  const { llm, corpus, passScore } = deps;

  // ── Supervisor ──────────────────────────────────────────────────────────────
  async function supervisor(state: State): Promise<Partial<State>> {
    const t0 = Date.now();
    const d = decide(state);
    const update: Partial<State> = { next: d.next, trace: [ev("supervisor", t0, d.reason)] };
    if (d.newTasks?.length) update.tasks = d.newTasks;
    if (d.iteration !== undefined) update.iteration = d.iteration;
    return update;
  }

  function route(state: State) {
    switch (state.next) {
      case "plan":
        return "planner";
      case "research":
        return state.tasks
          .filter((t) => t.status === "pending")
          .map((task) => new Send("researcher", { task, request: state.request }));
      case "write": {
        const plan = state.plan!;
        const ids = sectionsToWrite(plan, state.iteration, state.review, state.findings, state.tasks);
        const fb = new Map<string, string[]>();
        for (const f of state.review?.sectionFeedback ?? []) fb.set(f.sectionId, [...(fb.get(f.sectionId) ?? []), f.feedback]);
        return ids.map(
          (id) =>
            new Send("writer", {
              section: plan.sections.find((s) => s.id === id),
              plan,
              request: state.request,
              findings: state.findings,
              sources: state.sources,
              iteration: state.iteration,
              previous: state.iteration > 0 ? state.sections[id]?.body : undefined,
              feedback: state.iteration > 0 ? [state.review?.summary, ...(fb.get(id) ?? [])].filter(Boolean).join("\n- ") : undefined,
            }),
        );
      }
      case "review":
        return "reviewer";
      default:
        return END;
    }
  }

  // ── Workers ─────────────────────────────────────────────────────────────────
  async function planner(state: State): Promise<Partial<State>> {
    const t0 = Date.now();
    const docType = getDocType(state.request.docType);
    const plan = await planDocument(llm, state.request, docType);
    const tasks: ResearchTask[] = plan.sections.flatMap((s) =>
      s.questions.map((question, i) => ({ id: `${s.id}-q${i + 1}`, sectionId: s.id, question, status: "pending" as const, round: 0 })),
    );
    return {
      plan,
      tasks,
      trace: [ev("planner", t0, `Outlined "${plan.title}": ${plan.sections.length} sections, ${tasks.length} research questions.`)],
    };
  }

  async function researcher(input: { task: ResearchTask; request: DraftRequest }): Promise<Partial<State>> {
    const t0 = Date.now();
    const docType = getDocType(input.request.docType);
    try {
      const finding = await research(llm, input.task, input.request, docType, corpus);
      return {
        findings: [finding],
        tasks: [{ ...input.task, status: "done" }],
        trace: [ev("researcher", t0, `Answered "${input.task.question}" with ${finding.rawSources.length} source(s).`)],
      };
    } catch (e: any) {
      // A failed question should not sink the whole run.
      return {
        tasks: [{ ...input.task, status: "done" }],
        trace: [ev("researcher", t0, `Failed "${input.task.question}": ${e?.message ?? e}`)],
      };
    }
  }

  async function collator(state: State): Promise<Partial<State>> {
    const t0 = Date.now();
    const fresh = state.findings.filter((f) => f.notes === undefined);
    const { sources, findings } = collate(state.sources, fresh);
    return {
      sources,
      findings,
      trace: [ev("collator", t0, `Merged ${fresh.length} finding(s); source registry now has ${sources.length} unique source(s).`)],
    };
  }

  async function writer(input: {
    section: Plan["sections"][number];
    plan: Plan;
    request: DraftRequest;
    findings: Finding[];
    sources: Source[];
    iteration: number;
    previous?: string;
    feedback?: string;
  }): Promise<Partial<State>> {
    const t0 = Date.now();
    const docType = getDocType(input.request.docType);
    const body = await writeSection(llm, docType, { ...input, docTypeId: docType.id });
    const draft: SectionDraft = { sectionId: input.section.id, heading: input.section.heading, body, iteration: input.iteration };
    return {
      sections: { [input.section.id]: draft },
      trace: [ev("writer", t0, `${input.iteration ? "Revised" : "Drafted"} "${input.section.heading}" (${body.split(/\s+/).length} words).`)],
    };
  }

  async function assembler(state: State): Promise<Partial<State>> {
    const t0 = Date.now();
    const plan = state.plan!;
    const ordered = plan.sections.map((s) => state.sections[s.id]).filter(Boolean) as SectionDraft[];
    const { bodies, references, dropped } = renumber(
      ordered.map((s) => s.body),
      state.sources,
    );
    const assembled = ordered.map((s, i) => ({ ...s, body: bodies[i] }));
    const document = renderMarkdown(plan, state.request, assembled, references);
    return {
      assembled,
      references,
      document,
      draftIteration: state.iteration,
      trace: [
        ev(
          "assembler",
          t0,
          `Assembled ${assembled.length} sections with ${references.length} cited reference(s)${dropped ? `; removed ${dropped} invalid citation(s)` : ""}.`,
        ),
      ],
    };
  }

  async function reviewer(state: State): Promise<Partial<State>> {
    const t0 = Date.now();
    const docType = getDocType(state.request.docType);
    const review = await reviewDocument(llm, docType, {
      request: state.request,
      plan: state.plan!,
      sections: state.assembled,
      sources: state.references,
      iteration: state.iteration,
      passScore,
    });
    return {
      review,
      reviews: [review],
      reviewIteration: state.iteration,
      trace: [ev("reviewer", t0, `Score ${review.score}/10 — ${review.summary}`)],
    };
  }

  return new StateGraph(ScriptoriumState)
    .addNode("supervisor", supervisor)
    .addNode("planner", planner)
    .addNode("researcher", researcher as any)
    .addNode("collator", collator)
    .addNode("writer", writer as any)
    .addNode("assembler", assembler)
    .addNode("reviewer", reviewer)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", route as any, ["planner", "researcher", "writer", "reviewer", END])
    .addEdge("planner", "supervisor")
    .addEdge("researcher", "collator")
    .addEdge("collator", "supervisor")
    .addEdge("writer", "assembler")
    .addEdge("assembler", "supervisor")
    .addEdge("reviewer", "supervisor")
    .compile();
}

export function renderMarkdown(plan: Plan, req: DraftRequest, sections: SectionDraft[], references: Source[]): string {
  const docType = getDocType(req.docType);
  const date = new Date().toISOString().slice(0, 10);
  const parts = [
    `# ${plan.title}`,
    `*${docType.label} · Prepared for ${req.audience || docType.defaultAudience} · ${date}*`,
    ...sections.map((s) => `## ${s.heading}\n\n${s.body}`),
  ];
  if (references.length) {
    parts.push(
      `## References\n\n` +
        references
          .map((r) => (r.kind === "local" ? `${r.id}. ${r.title} *(local document)*` : `${r.id}. [${r.title}](${r.url})`))
          .join("\n"),
    );
  }
  return parts.join("\n\n") + "\n";
}
