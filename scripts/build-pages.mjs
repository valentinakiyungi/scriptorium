// Builds the static GitHub Pages site into dist/pages:
//   - bundles the browser pipeline (src/browser.ts) with esbuild
//   - copies the web app and wires it to the in-browser pipeline
import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist", "pages");
const repo = process.env.SCRIPTORIUM_REPO || "https://github.com/valentinakiyungi/scriptorium";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src", "browser.ts")],
  outfile: join(out, "scriptorium.js"),
  bundle: true,
  format: "iife",
  globalName: "ScriptoriumBrowser",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // LangGraph's /web entry avoids Node's async_hooks so the graph runs in browsers.
  alias: { "@langchain/langgraph": "@langchain/langgraph/web" },
  define: { "process.env.NODE_ENV": '"production"' },
  metafile: true,
  logLevel: "warning",
});

const html = readFileSync(join(root, "public", "index.html"), "utf8");
const meta = `<meta name="description" content="Scriptorium — an autonomous multi-agent research and drafting system. A LangGraph Supervisor-Worker team researches the live web with Gemini and drafts structured, cited documents." />
<meta property="og:title" content="Scriptorium — autonomous research & drafting" />
<meta property="og:description" content="AI agents research the live web, draft every section in parallel and fact-check themselves — returning a structured, cited document." />
<meta property="og:type" content="website" />`;
const boot = `<script>window.SCRIPTORIUM_REPO = ${JSON.stringify(repo)};</script>\n<script src="./scriptorium.js"></script>\n`;
if (!html.includes("<script>\n// ── Icons")) throw new Error("index.html layout changed: can't find the main script to inject before");
const page = html.replace("</title>", `</title>\n${meta}`).replace("<script>\n// ── Icons", `${boot}<script>\n// ── Icons`);
writeFileSync(join(out, "index.html"), page);
writeFileSync(join(out, ".nojekyll"), "");

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + (o.bytes || 0), 0);
console.log(`✔ Built GitHub Pages site → dist/pages (bundle ${kb(bytes)})`);
