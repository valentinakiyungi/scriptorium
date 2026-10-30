// Shared domain types for Scriptorium.

export interface DraftRequest {
  topic: string;
  docType: string;
  audience?: string;
  instructions?: string;
  /** Max reviewer-driven revision rounds after the first draft. */
  maxRevisions: number;
  /** Max research questions in the initial plan. */
  maxQuestions: number;
  /** Use Gemini Google Search grounding for web research. */
  web: boolean;
  /** Folder of local .md/.txt files to use as an extra research corpus. */
  dataDir?: string;
}

export interface SectionPlan {
  id: string;
  heading: string;
  goal: string;
  /** Research questions this section needs answered. Empty = synthesize from all evidence. */
  questions: string[];
}

export interface Plan {
  title: string;
  summary: string;
  sections: SectionPlan[];
}

export interface ResearchTask {
  id: string;
  sectionId: string;
  question: string;
  status: "pending" | "done";
  /** Revision round that created the task (0 = initial plan). */
  round: number;
}

export interface Source {
  id: number; // global, stable within a run (1-based)
  url: string;
  title: string;
  kind: "web" | "local";
}

export interface RawSource {
  url: string;
  title: string;
  kind: "web" | "local";
}

export interface Finding {
  id: string; // = task id
  taskId: string;
  sectionId: string;
  question: string;
  /** Notes with local markers [[k]] (0-based index into rawSources). */
  rawNotes: string;
  rawSources: RawSource[];
  /** Notes rewritten with global source ids, e.g. [3]. Filled by the collator. */
  notes?: string;
  sourceIds?: number[];
  searchQueries?: string[];
  ms: number;
}

export interface SectionDraft {
  sectionId: string;
  heading: string;
  body: string;
  iteration: number;
}

export interface SectionFeedback {
  sectionId: string;
  feedback: string;
}

export interface Review {
  iteration: number;
  score: number; // 1-10
  passes: boolean;
  summary: string;
  sectionFeedback: SectionFeedback[];
  gapQuestions: { sectionId: string; question: string }[];
}

export interface TraceEvent {
  at: string; // ISO timestamp
  agent: string;
  ms: number;
  message: string;
}

export type Route = "plan" | "research" | "write" | "review" | "finish";

export interface Usage {
  calls: number;
  promptTokens: number;
  outputTokens: number;
}
