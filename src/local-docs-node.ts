import * as fs from "node:fs";
import * as path from "node:path";
import { chunkText, LocalCorpus } from "./local-docs.ts";

/** Load every .md / .txt file under a folder into a searchable corpus (Node only). */
export function loadCorpus(dir?: string): LocalCorpus {
  const corpus = new LocalCorpus();
  if (!dir || !fs.existsSync(dir)) return corpus;
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      // README files describe the folder itself, so they are never treated as sources.
      return /\.(md|markdown|txt)$/i.test(e.name) && !/^readme\./i.test(e.name) ? [p] : [];
    });
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    chunkText(fs.readFileSync(file, "utf8")).forEach((text, index) => corpus.add(rel, index, text));
  }
  corpus.finish();
  return corpus;
}
