// A small client for the agent's WebSocket protocol, shared by the smoke test
// and the evaluation runner: method calls, one chat turn at a time, and the
// agent's synced state.

const TURN_TIMEOUT_MS = 90_000;
const RPC_TIMEOUT_MS = 30_000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 5_000;
// The meter state follows the last chat frame; allow it a moment.
const STATE_SETTLE_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the agent's WebSocket, retrying a failed connection after a deploy. */
async function connect(baseUrl, headers, instance) {
  const url = `${baseUrl.replace(/^http/, "ws")}/agents/invoice-buddy-agent/${instance}`;
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers });
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error("WebSocket connection failed"));
      });
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      console.log(
        `  connection failed, retrying (${attempt}/${CONNECT_ATTEMPTS})`
      );
      await sleep(CONNECT_RETRY_MS);
    }
  }
}

/** A session with the agent: method calls, one chat turn, and state updates. */
export async function openAgent({ baseUrl, headers = {}, instance }) {
  const socket = await connect(baseUrl, headers, instance);
  const pending = new Map();
  const states = [];
  let onChatFrame = () => {};
  let calls = 0;
  socket.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame.type === "cf_agent_state") states.push(frame.state);
    if (frame.type === "cf_agent_use_chat_response") onChatFrame(frame);
    if (frame.type === "rpc" && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.success) resolve(frame.result);
      else reject(new Error(frame.error ?? "call failed"));
    }
  };
  return {
    states,
    close: () => socket.close(),
    /** Empties the conversation, so every run sends the model the same small context. */
    clearHistory: () =>
      socket.send(JSON.stringify({ type: "cf_agent_chat_clear" })),
    call(method, args = []) {
      return new Promise((resolve, reject) => {
        const id = `smoke-rpc-${++calls}`;
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out`)),
          RPC_TIMEOUT_MS
        );
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error))
        });
        socket.send(JSON.stringify({ type: "rpc", id, method, args }));
      });
    },
    ask(question) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("chat turn timed out")),
          TURN_TIMEOUT_MS
        );
        let text = "";
        const tools = new Set();
        const inputs = [];
        const outputs = [];
        const toolById = new Map();
        onChatFrame = (frame) => {
          try {
            const part = JSON.parse(frame.body);
            if (part.type === "text-delta") text += part.delta ?? "";
            if (part.toolName) tools.add(part.toolName);
            if (part.type === "tool-input-available") {
              inputs.push({ tool: part.toolName, input: part.input });
              toolById.set(part.toolCallId, part.toolName);
            }
            if (part.type === "tool-output-available") {
              outputs.push({
                tool: toolById.get(part.toolCallId) ?? "",
                output: part.output
              });
            }
          } catch {
            // Frames without a JSON body carry no text.
          }
          if (frame.done) {
            clearTimeout(timer);
            sleep(STATE_SETTLE_MS).then(() =>
              resolve({ text, tools: [...tools], inputs, outputs })
            );
          }
        };
        socket.send(
          JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: `smoke-${Date.now()}`,
            init: {
              method: "POST",
              body: JSON.stringify({
                messages: [
                  {
                    id: `smoke-user-${Date.now()}`,
                    role: "user",
                    parts: [{ type: "text", text: question }]
                  }
                ]
              })
            }
          })
        );
      });
    }
  };
}
