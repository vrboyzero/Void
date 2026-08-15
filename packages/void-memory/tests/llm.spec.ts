import { describe, expect, it } from "vitest";
import { requestChatCompletionViaLlm, type LlmLike } from "../src/llm.js";

function fakeLlm(texts: string[]): LlmLike {
  return {
    async *stream() {
      for (const text of texts) {
        yield { type: "text-delta", index: 0, text };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    },
  };
}

describe("requestChatCompletionViaLlm (openai→ctx.llm patch)", () => {
  it("collects text-delta chunks into a chat-completion response", async () => {
    const llm = fakeLlm(["the void ", "remembers ", "hello"]);
    const response = await requestChatCompletionViaLlm(llm, {
      model: "deepseek-chat",
      messages: [{ role: "user", content: "summarize" }],
    });
    expect(response.choices[0]!.message.content).toBe("the void remembers hello");
  });

  it("returns empty content for an empty stream", async () => {
    const llm = fakeLlm([]);
    const response = await requestChatCompletionViaLlm(llm, { messages: [] });
    expect(response.choices[0]!.message.content).toBe("");
  });
});
