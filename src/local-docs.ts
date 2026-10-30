/** A chunk of a local document. */
export interface Chunk {
  file: string;
  /** Set when the chunk came from a web page the user attached. */
  url?: string;
  index: number;
  text: string;
  terms: Map<string, number>;
  length: number;
}

const STOP = new Set(
  "a an and are as at be by for from has have in is it its of on or that the this to was were will with what how why which who when does do can".split(" "),
);

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export function chunkText(text: string, size = 1200): string[] {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length > size) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > size * 1.5) {
      chunks.push(cur.slice(0, size));
      cur = cur.slice(size);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** In-memory BM25 index over a folder of .md / .txt files. Zero external services required. */
export class LocalCorpus {
  readonly chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  /** Chunk and index a whole document (e.g. a file, URL or pasted text attached in the UI). */
  addDocument(file: string, text: string, url?: string): void {
    chunkText(text).forEach((t, i) => this.add(file, i, t, url));
    this.finish();
  }

  add(file: string, index: number, text: string, url?: string): void {
    const toks = tokenize(text);
    const terms = new Map<string, number>();
    for (const t of toks) terms.set(t, (terms.get(t) ?? 0) + 1);
    this.chunks.push({ file, url, index, text, terms, length: toks.length });
  }

  finish(): void {
    this.df.clear();
    for (const c of this.chunks) for (const t of c.terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    this.avgLen = this.chunks.reduce((a, c) => a + c.length, 0) / Math.max(1, this.chunks.length);
  }

  get size(): number {
    return this.chunks.length;
  }

  search(query: string, k = 3, minScore = 1.0): { chunk: Chunk; score: number }[] {
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length;
    const k1 = 1.4;
    const b = 0.75;
    return this.chunks
      .map((chunk) => {
        let score = 0;
        for (const t of q) {
          const tf = chunk.terms.get(t);
          if (!tf) continue;
          const df = this.df.get(t) ?? 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.length) / (this.avgLen || 1)));
        }
        return { chunk, score };
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
