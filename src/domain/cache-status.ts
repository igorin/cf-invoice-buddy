/**
 * Tells whether AI Gateway served a model call from its cache (spec section
 * 10). A cached call uses no neurons, so the cost meter leaves it out.
 */

/** The response header AI Gateway sets on every call. */
export const CACHE_STATUS_HEADER = "cf-aig-cache-status";

/**
 * Only an explicit hit counts as served from the cache. Any other value, or
 * no value, is counted as usage, so a doubt never lowers the meter.
 */
export function isCacheHit(status: string | null | undefined): boolean {
  return status?.trim().toUpperCase() === "HIT";
}

type Runner = { run: (...args: never[]) => Promise<unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Reports, for each streamed call, whether the gateway served it from its
 * cache. The binding returns only the stream unless asked for the whole
 * response, so each streamed call is made with `returnRawResponse` and its
 * stream handed on as before. Calls that do not stream are left alone.
 */
export function withCacheStatus<T extends Runner>(
  binding: T,
  onCall: (servedFromCache: boolean) => void
): T {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property !== "run") return Reflect.get(target, property, receiver);
      return async (...args: never[]) => {
        const [model, inputs, options] = args as unknown[];
        const streams = isRecord(inputs) && inputs.stream === true;
        const callerWantsRaw =
          isRecord(options) && options.returnRawResponse === true;
        if (!streams || callerWantsRaw) {
          onCall(false);
          return await target.run(...args);
        }
        const run = target.run as (...all: unknown[]) => Promise<unknown>;
        const result = await run.call(target, model, inputs, {
          ...(isRecord(options) ? options : {}),
          returnRawResponse: true
        });
        if (!(result instanceof Response)) {
          onCall(false);
          return result;
        }
        if (!result.ok) {
          onCall(false);
          // As the binding does without the option: a failed call throws.
          throw new Error(`${result.status}: ${await result.text()}`);
        }
        onCall(isCacheHit(result.headers.get(CACHE_STATUS_HEADER)));
        return result.body;
      };
    }
  });
}
