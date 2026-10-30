import type { Usage } from "../types.ts";

/** Which agent is calling — used for logging and by the mock provider. */
export type Purpose = "plan" | "research" | "write" | "review";

export interface TextRequest {
  purpose: Purpose;
  system: string;
  prompt: string;
  temperature?: number;
}

export interface JsonRequest extends TextRequest {
  /** Gemini responseSchema (OpenAPI subset, uppercase types). */
  schema: Record<string, unknown>;
}

export interface GroundingChunk {
  uri: string;
  title: string;
}

export interface GroundingSupport {
  /** UTF-8 byte offsets into the response text, as returned by Gemini. */
  startIndex: number;
  endIndex: number;
  text: string;
  chunkIndices: number[];
}

export interface GroundedResult {
  text: string;
  chunks: GroundingChunk[];
  supports: GroundingSupport[];
  queries: string[];
}

export interface LLM {
  readonly name: string;
  readonly usage: Usage;
  text(req: TextRequest): Promise<string>;
  json<T>(req: JsonRequest): Promise<T>;
  /** Text generation with live Google Search grounding. */
  search(req: TextRequest): Promise<GroundedResult>;
}
