import type { DocType } from "../doctypes.ts";
import type { LLM } from "../llm/types.ts";
import type { DraftRequest, Finding, Plan, SectionPlan, Source } from "../types.ts";

export interface WriterInput {
  section: SectionPlan;
  plan: Plan;
  request: DraftRequest;
  docTypeId: string;
  findings: Finding[];
  sources: Source[];
  iteration: number;
  feedback?: string;
  previous?: string;
}

export function writerSystem(docType: DocType): string {
  return `You are a Writer agent drafting one section of a ${docType.label}.
Voice: ${docType.tone}.
Citation rules (strict):
- Support factual claims with numeric citations like [3] placed right after the claim, using ONLY the source numbers listed.
- Never invent sources, numbers or URLs. If the evidence does not cover something, leave it out or say it is unclear.
- Do not add a references list; it is generated automatically.
Format rules:
- Output Markdown for the section BODY only. Do not repeat the section heading.
- You may use paragraphs, bullet lists, short tables and ### sub-headings where useful.`;
}

export function wordBudget(docType: DocType, sectionId: string): number {
  const n = docType.sections.length;
  const base = docType.targetWords / n;
  const t = docType.sections.find((s) => s.id === sectionId);
  // Summary-style sections are shorter, research sections longer.
  return Math.round(t?.research ? base * 1.25 : base * 0.6);
}

/** Pick evidence for this section: its own findings first, then the rest, within a size budget. */
export function selectEvidence(section: SectionPlan, findings: Finding[], maxChars = 14_000): Finding[] {
  const own = findings.filter((f) => f.sectionId === section.id);
  const other = findings.filter((f) => f.sectionId !== section.id);
  const picked: Finding[] = [];
  let size = 0;
  for (const f of [...own, ...other]) {
    const len = (f.notes ?? f.rawNotes).length + f.question.length;
    if (size + len > maxChars && picked.length >= Math.max(1, own.length)) break;
    picked.push(f);
    size += len;
  }
  return picked;
}

export async function writeSection(llm: LLM, docType: DocType, input: WriterInput): Promise<string> {
  const { section, plan, request } = input;
  const evidence = selectEvidence(section, input.findings);
  const cited = new Set(evidence.flatMap((f) => f.sourceIds ?? []));
  const sourceList = input.sources.filter((s) => cited.has(s.id));

  const outline = plan.sections.map((s) => `- ${s.heading}${s.id === section.id ? "  <-- you are writing this" : ""}`).join("\n");
  const evidenceBlock = evidence.length
    ? evidence
        .map((f) => `Q: ${f.question}${f.sectionId === section.id ? " (for this section)" : ""}\n${f.notes ?? f.rawNotes}`)
        .join("\n\n")
    : "(no research evidence available — write cautiously and avoid specific statistics)";

  const revision = input.previous
    ? `\n\nThis is revision round ${input.iteration}. Your previous draft:\n<previous>\n${input.previous}\n</previous>\nReviewer feedback to address:\n<feedback>${input.feedback || "Improve clarity, evidence and citations."}</feedback>`
    : "";

  const prompt = `Document: "${plan.title}" (${docType.label})
Topic: ${request.topic}
Audience: ${request.audience || docType.defaultAudience}
Extra instructions: ${request.instructions || "none"}

Outline:
${outline}

Section to write: <section id="${section.id}">${section.heading}</section>
Goal: ${section.goal}
Target length: about ${wordBudget(docType, section.id)} words.

<sources>
${sourceList.map((s) => `[${s.id}] ${s.title} — ${s.url}`).join("\n") || "(none)"}
</sources>

<evidence>
${evidenceBlock}
</evidence>${revision}`;

  const body = await llm.text({ purpose: "write", system: writerSystem(docType), prompt, temperature: 0.5 });
  return stripLeadingHeading(body, section.heading);
}

function stripLeadingHeading(body: string, heading: string): string {
  let out = body.trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, "$1").trim();
  const first = out.split("\n")[0];
  if (/^#{1,3}\s/.test(first) && first.replace(/^#+\s*/, "").toLowerCase().includes(heading.toLowerCase().slice(0, 12))) {
    out = out.split("\n").slice(1).join("\n").trim();
  }
  return out;
}
