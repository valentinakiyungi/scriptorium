// Document type templates. Each one defines structure, voice and the reviewer's rubric.

export interface SectionTemplate {
  id: string;
  heading: string;
  goal: string;
  /** Whether this section normally needs its own research questions. */
  research: boolean;
}

export interface DocType {
  id: string;
  label: string;
  description: string;
  defaultAudience: string;
  tone: string;
  targetWords: number;
  sections: SectionTemplate[];
  rubric: string[];
}

const s = (id: string, heading: string, goal: string, research = true): SectionTemplate => ({
  id,
  heading,
  goal,
  research,
});

export const DOC_TYPES: DocType[] = [
  {
    id: "research-report",
    label: "Research Report",
    description: "In-depth, evidence-led report on a topic with findings and implications.",
    defaultAudience: "informed professionals",
    tone: "objective, analytical, precise",
    targetWords: 1800,
    sections: [
      s("summary", "Executive Summary", "Key findings and why they matter, in one tight paragraph plus 3-5 bullets.", false),
      s("background", "Background", "Context and definitions a reader needs before the findings."),
      s("findings", "Key Findings", "The main evidence-backed findings, with figures and dates."),
      s("analysis", "Analysis", "What explains the findings; trade-offs, competing views, uncertainty."),
      s("implications", "Implications & Recommendations", "What the findings mean and what to do about them."),
      s("conclusion", "Conclusion", "Short close restating the core insight.", false),
    ],
    rubric: [
      "Every factual claim is supported by a citation",
      "Findings include concrete numbers, dates or named entities",
      "Analysis acknowledges uncertainty or competing evidence",
      "Recommendations follow logically from the findings",
    ],
  },
  {
    id: "literature-review",
    label: "Literature Review",
    description: "Synthesis of existing studies and sources: themes, debates and gaps.",
    defaultAudience: "researchers and graduate students",
    tone: "scholarly, balanced, synthesising rather than listing",
    targetWords: 2000,
    sections: [
      s("introduction", "Introduction & Scope", "Define the field, the question, and inclusion scope."),
      s("themes", "Major Themes", "Group the literature into 2-4 themes and synthesise each."),
      s("debates", "Debates & Contradictions", "Where sources disagree and why."),
      s("methods", "Methodological Trends", "How the topic is typically studied and limits of those methods."),
      s("gaps", "Research Gaps", "What remains unknown or under-studied."),
      s("conclusion", "Conclusion", "Overall state of knowledge and future directions.", false),
    ],
    rubric: [
      "Synthesises across sources instead of summarising one at a time",
      "Identifies at least one genuine disagreement in the literature",
      "Names concrete research gaps",
      "Citations are dense and attributable",
    ],
  },
  {
    id: "executive-brief",
    label: "Executive Brief",
    description: "One-to-two page decision brief for a busy leader.",
    defaultAudience: "senior executives",
    tone: "crisp, direct, bottom-line-up-front",
    targetWords: 700,
    sections: [
      s("bluf", "Bottom Line", "The single most important takeaway and recommended decision.", false),
      s("situation", "Situation", "What is happening and why it matters now."),
      s("options", "Options", "2-3 realistic options with pros, cons and cost/risk signals."),
      s("recommendation", "Recommendation & Next Steps", "Chosen option, owners, and timeline.", false),
    ],
    rubric: [
      "The bottom line is stated in the first two sentences",
      "Options are mutually exclusive and comparable",
      "No section exceeds what a busy executive will read",
      "Key numbers are cited",
    ],
  },
  {
    id: "policy-memo",
    label: "Policy Memo",
    description: "Problem, options and recommendation for a policy decision-maker.",
    defaultAudience: "policy makers and their staff",
    tone: "neutral, rigorous, plain language",
    targetWords: 1200,
    sections: [
      s("summary", "Summary", "Problem and recommendation in brief.", false),
      s("problem", "Problem Statement", "Scope, scale and who is affected, with data."),
      s("context", "Current Policy Landscape", "Existing laws, programmes and what other jurisdictions do."),
      s("options", "Policy Options", "2-3 options, each with expected impact, cost and feasibility."),
      s("recommendation", "Recommendation", "Preferred option, implementation steps and risks."),
    ],
    rubric: [
      "Problem is quantified with cited data",
      "Options are evaluated on consistent criteria",
      "Recommendation addresses implementation and risk",
      "Language is neutral and non-partisan",
    ],
  },
  {
    id: "technical-whitepaper",
    label: "Technical Whitepaper",
    description: "Explains a technology or approach, its architecture and trade-offs.",
    defaultAudience: "engineers and technical decision-makers",
    tone: "technical, concrete, vendor-neutral",
    targetWords: 2000,
    sections: [
      s("abstract", "Abstract", "What the paper covers and its main conclusion.", false),
      s("problem", "Problem & Motivation", "The technical problem and why existing approaches fall short."),
      s("approach", "Technical Approach", "How the technology works: components, data flow, key mechanisms."),
      s("evaluation", "Performance & Evaluation", "Benchmarks, measured results and comparisons."),
      s("tradeoffs", "Trade-offs & Limitations", "Costs, risks and where the approach does not fit."),
      s("adoption", "Adoption Guidance", "When and how to adopt; practical steps."),
    ],
    rubric: [
      "Mechanisms are explained, not just named",
      "Performance claims cite measurements",
      "Limitations are stated honestly",
      "Guidance is actionable",
    ],
  },
  {
    id: "blog-article",
    label: "Blog Article",
    description: "Engaging, well-sourced explainer for a general audience.",
    defaultAudience: "curious general readers",
    tone: "engaging, clear, conversational but accurate",
    targetWords: 1100,
    sections: [
      s("hook", "Introduction", "A hook and why the reader should care.", false),
      s("explainer", "What's Going On", "Plain-language explanation of the topic."),
      s("evidence", "What the Evidence Says", "The key facts and numbers, with sources."),
      s("perspectives", "Different Perspectives", "How different groups or experts see it."),
      s("takeaways", "Takeaways", "What the reader should remember or do.", false),
    ],
    rubric: [
      "Opens with a hook that states the stakes",
      "Jargon is explained",
      "Facts and numbers are cited",
      "Ends with clear takeaways",
    ],
  },
  {
    id: "grant-proposal",
    label: "Grant Proposal",
    description: "Funding proposal: need, aims, methods, impact and budget outline.",
    defaultAudience: "grant reviewers",
    tone: "persuasive, specific, evidence-based",
    targetWords: 1800,
    sections: [
      s("summary", "Project Summary", "One-paragraph summary of need, aims and impact.", false),
      s("need", "Statement of Need", "The problem, its scale and evidence that it matters."),
      s("aims", "Aims & Objectives", "Specific, measurable aims.", false),
      s("methods", "Approach & Methods", "How the aims will be achieved, informed by prior work."),
      s("impact", "Expected Impact & Evaluation", "Outcomes, metrics and how success is measured."),
      s("budget", "Budget Outline & Timeline", "High-level budget categories and milestones.", false),
    ],
    rubric: [
      "Need is established with cited evidence",
      "Aims are specific and measurable",
      "Methods are grounded in prior work",
      "Evaluation metrics are defined",
    ],
  },
];

export function getDocType(id: string): DocType {
  const t = DOC_TYPES.find((d) => d.id === id);
  if (!t) {
    throw new Error(`Unknown document type "${id}". Available: ${DOC_TYPES.map((d) => d.id).join(", ")}`);
  }
  return t;
}
