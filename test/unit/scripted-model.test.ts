import { describe, expect, it } from "vitest";
import { checkGrounding } from "../../src/domain/grounding";
import {
  SCRIPTED_DECLINE,
  scriptedBinding,
  scriptedReply,
  scriptedStream,
  scriptedToolFor
} from "../../src/domain/scripted-model";
import { chooseModel } from "../../src/model";

const base = {
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_API_TOKEN: "test-token-not-a-real-credential",
  DAILY_NEURON_BUDGET: "500",
  SMOKE_DAILY_NEURON_BUDGET: "2500",
  ENVIRONMENT: "local",
  ACCESS_TEAM_DOMAIN: "local.cloudflareaccess.com",
  ACCESS_AUD: "0".repeat(64),
  SCRIPTED_MODEL: "1"
};

describe("scriptedToolFor", () => {
  it.each([
    ["Why is my bill higher than usual?", "explainBillChange"],
    ["What have I used this month?", "getUsageSummary"],
    ["I want a credit for the Workers spike", "draftCreditRequest"],
    ["Please close last month", "startInvoiceClose"],
    ["Would another plan be cheaper?", "comparePlans"],
    ["What does this assistant cost me?", "getAssistantCost"],
    ["Switch to test mode", "setDataMode"]
  ])("picks a tool for %j", (message, tool) => {
    expect(scriptedToolFor(message)?.name).toBe(tool);
  });

  it("calls no tool for anything else", () => {
    expect(scriptedToolFor("Tell me a joke")).toBeNull();
  });

  it("quotes the owner's words as the reason for a credit", () => {
    expect(scriptedToolFor("A credit please: it looped.")?.args).toEqual({
      service: "Workers",
      ownerReason: "A credit please: it looped.",
      replaceExisting: true
    });
  });
});

describe("scriptedStream", () => {
  const user = (content: unknown) => ({ role: "user", content });

  it("calls the tool for the owner's latest message", () => {
    const stream = scriptedStream([
      user("Tell me a joke"),
      { role: "assistant", content: SCRIPTED_DECLINE },
      user("Why is my bill higher?")
    ]);
    expect(stream).toContain('"name":"explainBillChange"');
    expect(stream).toContain('"finish_reason":"tool_calls"');
    expect(stream.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("answers in words once the tool has returned, and labels test data", () => {
    const stream = scriptedStream([
      user("Why is my bill higher?"),
      { role: "tool", content: '{"notice":"TEST DATA from scenario"}' }
    ]);
    expect(stream).toContain(
      "The details are in the card above. This is test data."
    );
    expect(stream).toContain('"finish_reason":"stop"');
    expect(scriptedReply("{}")).not.toContain("test data");
  });

  it("declines a question it has no tool for, and copes with odd input", () => {
    expect(scriptedStream([user("Tell me a joke")])).toContain(
      SCRIPTED_DECLINE
    );
    expect(scriptedStream([])).toContain(SCRIPTED_DECLINE);
    expect(
      scriptedStream([user([{ type: "text", text: "what have I used" }])])
    ).toContain("getUsageSummary");
  });

  it("writes replies the response checker passes", () => {
    for (const reply of [scriptedReply("TEST DATA"), SCRIPTED_DECLINE]) {
      expect(
        checkGrounding({
          text: reply,
          toolResults: [],
          ownerText: "",
          docsUrls: [],
          allowedUrls: [],
          explainOutcome: "explained",
          estimateRequired: true
        })
      ).toEqual([]);
    }
  });
});

describe("scriptedBinding", () => {
  it("returns the script as a stream, and reports token usage", async () => {
    const stream = await scriptedBinding().run("model", {
      messages: [{ role: "user", content: "what have I used?" }]
    });
    const text = await new Response(stream).text();
    expect(text).toContain("getUsageSummary");
    expect(text).toContain('"prompt_tokens":10');
    expect(
      await new Response(await scriptedBinding().run("m", null)).text()
    ).toContain(SCRIPTED_DECLINE);
  });
});

describe("where the script may run", () => {
  it("runs for every instance in local development when switched on", () => {
    expect(chooseModel(base, false).scripted).toBe(true);
    expect(chooseModel(base, true).scripted).toBe(true);
  });

  it("is off unless switched on", () => {
    expect(
      chooseModel({ ...base, SCRIPTED_MODEL: "" }, false).scripted
    ).toBeUndefined();
    expect(
      chooseModel({ ...base, SCRIPTED_MODEL: "0" }, true).scripted
    ).toBeUndefined();
  });

  it.each(["staging", "production"])("never runs in %s", (ENVIRONMENT) => {
    expect(
      chooseModel({ ...base, ENVIRONMENT }, false).scripted
    ).toBeUndefined();
    expect(
      chooseModel({ ...base, ENVIRONMENT }, true).scripted
    ).toBeUndefined();
  });
});
