/**
 * Records the model's raw stream and plays it back (spec section 10, replay
 * tests). A recording is what the Workers AI binding returned, byte for
 * byte, so a replayed turn runs through the same stream handling, tools and
 * response checker as a live one, with no model call.
 */

export type RecordedCall = Readonly<{ chunks: ReadonlyArray<string> }>;

type Runner = { run: (...args: never[]) => Promise<unknown> };

/** Passes every call through unchanged and reports each finished stream. */
export function withRecording<T extends Runner>(
  binding: T,
  onCall: (call: RecordedCall) => void
): T {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property !== "run") return Reflect.get(target, property, receiver);
      return async (...args: never[]) => {
        const result = await target.run(...args);
        if (!(result instanceof ReadableStream)) return result;
        const decoder = new TextDecoder();
        const chunks: string[] = [];
        const keep = (text: string) => {
          if (text !== "") chunks.push(text);
        };
        return (result as ReadableStream<Uint8Array>).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(bytes, controller) {
              keep(decoder.decode(bytes, { stream: true }));
              controller.enqueue(bytes);
            },
            flush() {
              keep(decoder.decode());
              onCall({ chunks });
            }
          })
        );
      };
    }
  });
}

/**
 * Stands in for the Workers AI binding: each call returns the next recorded
 * stream. A turn that asks for more calls than were recorded fails, since
 * the code no longer behaves as it did when the recording was made.
 */
export function replayBinding(calls: ReadonlyArray<RecordedCall>): Runner {
  let next = 0;
  return {
    run: async () => {
      const call = calls[next];
      next += 1;
      if (call === undefined) {
        throw new Error(
          `The recording holds ${calls.length} model calls and the turn asked for another.`
        );
      }
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of call.chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        }
      });
    }
  };
}
