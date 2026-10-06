import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { withDedupedStream } from "./domain/dedupe-stream";

export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Builds the chat model. Tests replace `InvoiceBuddyAgent.modelFactory`. */
export function createModel(env: Env): LanguageModel {
  // Llama 3.3 streams each text chunk in two fields; see dedupe-stream.ts.
  const workersai = createWorkersAI({ binding: withDedupedStream(env.AI) });
  return workersai(MODEL_ID);
}
