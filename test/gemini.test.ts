import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { GeminiLLM, parseQuota, rankModels, resetQuotaMemory, supportsTemperature } from "../src/llm/gemini.ts";

// A fake Gemini endpoint reproducing a retired model (the real-world 404 users hit).
const seen: { model: string; body: any }[] = [];
let quotaMode = false;
let liteExhausted = false;
let listCalls = 0;
const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET") {
      listCalls++;
      return send(200, {
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-flash-image", supportedGenerationMethods: ["generateContent"] },
          { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
        ],
      });
    }
    const model = req.url!.match(/models\/([^:]+):generateContent/)![1];
    const body = JSON.parse(data);
    seen.push({ model, body });
    if (model === "gemini-3.8-flash" && quotaMode) {
      return send(429, {
        error: {
          code: 429,
          message: "You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash. Please retry in 9h17m58.05s.",
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "33438s" },
          ],
        },
      });
    }
    if (model === "gemini-3.5-flash-lite" && liteExhausted) {
      return send(429, { error: { message: "Quota exceeded ... per day ... limit: 20", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "30000s" }] } });
    }
    if (model === "gemini-2.5-flash") {
      return send(404, { error: { message: "This model models/gemini-2.5-flash is no longer available to new users." } });
    }
    const json = body.generationConfig?.responseMimeType === "application/json";
    return send(200, {
      candidates: [
        {
          content: { parts: [{ text: "thinking…", thought: true }, { text: json ? '{"ok":true}' : "Grid storage grew 40%." }] },
          groundingMetadata: body.tools
            ? { groundingChunks: [{ web: { uri: "https://iea.org/x", title: "iea.org" } }], groundingSupports: [{ segment: { startIndex: 0, endIndex: 22, text: "Grid storage grew 40%." }, groundingChunkIndices: [0] }] }
            : undefined,
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
  });
});

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.GEMINI_API_BASE = `http://127.0.0.1:${(server.address() as any).port}/v1beta/models`;
});
after(() => server.close());

test("ranks stable Flash models newest-first and skips special-purpose variants", () => {
  assert.deepEqual(rankModels(["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-3.8-flash-image", "gemini-3.8-flash", "gemini-3.1-pro-preview"]), [
    "gemini-3.8-flash",
    "gemini-2.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
  ]);
  assert.equal(supportsTemperature("gemini-2.5-flash"), true);
  assert.equal(supportsTemperature("gemini-3.8-flash"), false);
});

test("a retired model is replaced automatically, once, even with parallel workers", async () => {
  const changes: string[] = [];
  const llm = new GeminiLLM({ apiKey: "k", model: "gemini-2.5-flash", concurrency: 4, onModelChange: (c) => changes.push(`${c.role}:${c.from}->${c.to}`) });
  const results = await Promise.all([
    llm.text({ purpose: "write", system: "s", prompt: "p" }),
    llm.json<{ ok: boolean }>({ purpose: "plan", system: "s", prompt: "p", schema: {} }),
    llm.search({ purpose: "research", system: "s", prompt: "p" }),
    llm.search({ purpose: "research", system: "s", prompt: "p" }),
  ]);
  assert.equal(results[0], "Grid storage grew 40%.", "thought parts are skipped");
  assert.deepEqual(results[1], { ok: true });
  assert.equal((results[2] as any).chunks[0].uri, "https://iea.org/x");
  assert.equal(llm.name, "gemini:gemini-3.8-flash");
  assert.equal(listCalls, 1, "model list fetched once");
  assert.deepEqual(changes.sort(), ["main:gemini-2.5-flash->gemini-3.8-flash", "research:gemini-2.5-flash->gemini-3.8-flash"]);
  // Gemini 3 requests leave temperature at the model default.
  const ok = seen.filter((x) => x.model === "gemini-3.8-flash");
  assert.ok(ok.length >= 4);
  for (const x of ok) assert.equal(x.body.generationConfig?.temperature, undefined);
});

test("parses Google's 429 details into per-minute vs daily quota", () => {
  assert.deepEqual(parseQuota({ message: "slow down", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "17s" }] }), { exhausted: false, retryMs: 17000, limit: undefined });
  const daily = parseQuota({ message: "limit: 20 ... Please retry in 9h17m58.05s." });
  assert.equal(daily.exhausted, true);
  assert.equal(daily.limit, "20");
  assert.ok(daily.retryMs! > 9 * 3600_000);
});

test("a daily quota error switches to a model with its own quota instead of retrying", async () => {
  resetQuotaMemory();
  quotaMode = true;
  seen.length = 0;
  const notices: string[] = [];
  const llm = new GeminiLLM({ apiKey: "k", model: "gemini-3.8-flash", concurrency: 4 });
  llm.onNotice = (m) => notices.push(m);
  const out = await Promise.all([1, 2, 3].map(() => llm.text({ purpose: "write", system: "s", prompt: "p" })));
  assert.deepEqual(out, ["Grid storage grew 40%.", "Grid storage grew 40%.", "Grid storage grew 40%."]);
  const on38 = seen.filter((x) => x.model === "gemini-3.8-flash").length;
  assert.ok(on38 <= 3, `exhausted model was retried ${on38} times`);
  assert.ok(!/3\.8/.test(llm.name), "moved off the exhausted model");
  assert.equal(notices.filter((n) => /quota/.test(n)).length, 1, "one notice, not one per worker");

  // A new client in the same session skips the exhausted model without spending a request on it.
  seen.length = 0;
  const again = new GeminiLLM({ apiKey: "k", model: "gemini-3.8-flash" });
  await again.text({ purpose: "write", system: "s", prompt: "p" });
  assert.equal(seen.filter((x) => x.model === "gemini-3.8-flash").length, 0);
});

test("when every model is out of quota the error explains what to do", async () => {
  resetQuotaMemory();
  quotaMode = true;
  liteExhausted = true;
  const llm = new GeminiLLM({ apiKey: "k", model: "gemini-3.8-flash", concurrency: 1 });
  // 2.5-flash is retired (404) in the fake, 3.5-flash-lite and 3.8-flash are out of quota.
  await assert.rejects(llm.text({ purpose: "write", system: "s", prompt: "p" }), /daily quota is used up[\s\S]*resets in about \d+h[\s\S]*enable billing/);
  quotaMode = false;
  liteExhausted = false;
  resetQuotaMemory();
});
