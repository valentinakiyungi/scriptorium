import type { Finding, RawSource, Source } from "./types.ts";
import type { GroundingSupport } from "./llm/types.ts";

/**
 * Insert local citation markers [[k]] into grounded text using Gemini's groundingSupports.
 * Gemini reports segment offsets in UTF-8 bytes, so we work on encoded bytes (browser-safe).
 */
export function insertGroundingMarkers(text: string, supports: GroundingSupport[]): string {
  if (!supports.length) return text;
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  // Merge supports that end at the same byte offset.
  const byEnd = new Map<number, Set<number>>();
  for (const sp of supports) {
    let end = sp.endIndex;
    if (end <= 0 || end > bytes.length) {
      // Fall back to locating the segment text.
      const at = sp.text ? text.indexOf(sp.text) : -1;
      if (at === -1) continue;
      end = enc.encode(text.slice(0, at + sp.text.length)).length;
    }
    const set = byEnd.get(end) ?? new Set<number>();
    sp.chunkIndices.forEach((i) => set.add(i));
    byEnd.set(end, set);
  }
  const dec = new TextDecoder();
  const ends = [...byEnd.keys()].sort((a, b) => a - b);
  let out = "";
  let last = 0;
  for (const end of ends) {
    out += dec.decode(bytes.subarray(last, end)) + [...byEnd.get(end)!].sort((a, b) => a - b).map((i) => `[[${i}]]`).join("");
    last = end;
  }
  return out + dec.decode(bytes.subarray(last));
}

/** Canonical key for de-duplicating sources across researchers. */
export function sourceKey(src: RawSource): string {
  try {
    const u = new URL(src.url);
    u.hash = src.kind === "local" ? u.hash : "";
    for (const p of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(p)) u.searchParams.delete(p);
    return `${u.protocol}//${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}${u.search}${u.hash}`;
  } catch {
    return src.url.trim();
  }
}

/**
 * Collator: merge every researcher's local sources into one global registry with stable
 * numeric ids, and rewrite each finding's [[k]] markers to global [id] citations.
 */
export function collate(existing: Source[], findings: Finding[]): { sources: Source[]; findings: Finding[] } {
  const sources = existing.map((x) => ({ ...x }));
  const byKey = new Map(sources.map((x) => [sourceKey(x), x]));
  const updated: Finding[] = [];
  for (const f of findings) {
    const localToGlobal = f.rawSources.map((rs) => {
      const key = sourceKey(rs);
      let src = byKey.get(key);
      if (!src) {
        src = { id: sources.length + 1, url: rs.url, title: rs.title, kind: rs.kind };
        sources.push(src);
        byKey.set(key, src);
      }
      return src.id;
    });
    const notes = f.rawNotes.replace(/\[\[(\d+)\]\]/g, (_, k) => {
      const id = localToGlobal[Number(k)];
      return id ? `[${id}]` : "";
    });
    const cited = [...new Set([...notes.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
    updated.push({ ...f, notes: collapseAdjacentDupes(notes), sourceIds: cited.length ? cited : [...new Set(localToGlobal)] });
  }
  return { sources, findings: updated };
}

function collapseAdjacentDupes(s: string): string {
  return s.replace(/(\[\d+\])(\1)+/g, "$1");
}

/** Normalise "[1, 3]", "[1–3]", "[1][1]" into separate, unique "[1][3]" style markers. */
export function normalizeCitations(text: string): string {
  return text.replace(/\[(\d+(?:\s*(?:,|;|–|-|—)\s*\d+)+)\](?!\()/g, (_, inner: string) => {
    const ids: number[] = [];
    for (const part of inner.split(/\s*[,;]\s*/)) {
      const range = part.match(/^(\d+)\s*[–\-—]\s*(\d+)$/);
      if (range) {
        const [a, b] = [Number(range[1]), Number(range[2])];
        if (b >= a && b - a < 20) for (let i = a; i <= b; i++) ids.push(i);
      } else ids.push(Number(part));
    }
    return [...new Set(ids)].map((i) => `[${i}]`).join("");
  });
}

const CITE = /\[(\d+)\](?!\()/g;

/**
 * Validate and renumber citations across the whole document in order of first appearance.
 * Citations pointing at unknown sources are removed (never invent a reference).
 */
export function renumber(
  bodies: string[],
  sources: Source[],
): { bodies: string[]; references: Source[]; dropped: number } {
  const valid = new Map(sources.map((x) => [x.id, x]));
  const order = new Map<number, number>();
  let dropped = 0;
  const normalized = bodies.map(normalizeCitations);
  for (const b of normalized) {
    for (const m of b.matchAll(CITE)) {
      const id = Number(m[1]);
      if (valid.has(id) && !order.has(id)) order.set(id, order.size + 1);
    }
  }
  const out = normalized.map((b) =>
    collapseAdjacentDupes(
      b.replace(CITE, (_, n) => {
        const nn = order.get(Number(n));
        if (!nn) {
          dropped++;
          return "";
        }
        return `[${nn}]`;
      }),
    ).replace(/ +([.,;:])/g, "$1"),
  );
  const references = [...order.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([oldId, newId]) => ({ ...valid.get(oldId)!, id: newId }));
  return { bodies: out, references, dropped };
}

export function countCitations(text: string): number {
  return [...text.matchAll(CITE)].length;
}
