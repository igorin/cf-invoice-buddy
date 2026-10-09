import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { readConfig } from "./config";
import { withCacheStatus } from "./domain/cache-status";
import { withDedupedStream } from "./domain/dedupe-stream";
import { withRecording, type RecordedCall } from "./domain/model-recording";
import { CHAT_MODEL_ID } from "./domain/models";
import { scriptedBinding } from "./domain/scripted-model";

export const MODEL_ID = CHAT_MODEL_ID;

/** How long a cached smoke-test answer is served: a staging deploy and the production deploy that follows it. */
const DEFAULT_SMOKE_CACHE_TTL_SECONDS = 3_600;

export type ModelRequest = Readonly<{
  /** True for the smoke-test instance, the only one the options below reach. */
  smoke: boolean;
  onRecordedCall?: (call: RecordedCall) => void;
  /** Called once per model call: was it served from the gateway cache? */
  onCacheStatus?: (servedFromCache: boolean) => void;
}>;

export type ModelChoice = Readonly<{
  modelId: string;
  gateway?: Readonly<{ id: string; cacheTtl: number }>;
  record: boolean;
  /** True when a fixed script answers in place of the model. Local only. */
  scripted?: boolean;
}>;

/**
 * Decides how an instance reaches the model. An owner's instance always
 * gets the chat model, called directly. The smoke-test instance may be
 * given a cheaper model, a cached gateway when deployed, and recording
 * when run locally (spec section 10).
 */
export function chooseModel(env: unknown, smoke: boolean): ModelChoice {
  const result = readConfig(env);
  if (!result.ok) return { modelId: MODEL_ID, record: false };
  const config = result.config;
  const deployed = config.ENVIRONMENT !== "local";
  // The browser tests run every instance on the script; see scripted-model.ts.
  if (!deployed && config.SCRIPTED_MODEL === "1") {
    return { modelId: MODEL_ID, record: false, scripted: true };
  }
  if (!smoke) return { modelId: MODEL_ID, record: false };
  return {
    modelId: config.SMOKE_MODEL_ID ?? MODEL_ID,
    ...(deployed && config.AI_GATEWAY_ID !== undefined
      ? {
          gateway: {
            id: config.AI_GATEWAY_ID,
            cacheTtl:
              config.SMOKE_CACHE_TTL_SECONDS ?? DEFAULT_SMOKE_CACHE_TTL_SECONDS
          }
        }
      : {}),
    record: !deployed && config.RECORD_MODEL_CALLS === "1"
  };
}

/** Builds the chat model. Tests replace `InvoiceBuddyAgent.modelFactory`. */
export function createModel(
  env: Env,
  request: ModelRequest = { smoke: false }
): LanguageModel {
  const choice = chooseModel(env, request.smoke);
  if (choice.scripted) {
    const scripted = withDedupedStream(scriptedBinding()) as unknown as Ai;
    return createWorkersAI({ binding: scripted })(choice.modelId);
  }
  const recorded =
    choice.record && request.onRecordedCall
      ? withRecording(env.AI, request.onRecordedCall)
      : env.AI;
  // Only a call through the gateway can be a cache hit.
  const binding =
    choice.gateway && request.onCacheStatus
      ? withCacheStatus(recorded, request.onCacheStatus)
      : recorded;
  // Llama 3.3 streams each text chunk in two fields; see dedupe-stream.ts.
  const workersai = createWorkersAI({
    binding: withDedupedStream(binding),
    ...(choice.gateway ? { gateway: choice.gateway } : {})
  });
  return workersai(choice.modelId);
}
