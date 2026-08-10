import * as piAi from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

import { extractTextContent } from "../text-content.js";
import type { MockLLM, MockLLMDescriptor } from "./mock-llm.js";
import type { MockUserAction } from "./mock-user.js";

const registrations = new WeakMap<FauxProvider, piAi.FauxProviderRegistration>();

export const FAUX_PROVIDER = "supergsd-test";

export const FAUX_MODEL: Model<string> = {
  id: "deterministic",
  name: "Deterministic Test Model",
  api: "supergsd-test-api",
  provider: FAUX_PROVIDER,
  baseUrl: "memory://supergsd-test",
  reasoning: true,
  thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

export type PromptMessage = {
  role: string;
  text: string;
  stopReason?: string;
};

export class FauxProvider {
  constructor(
    private readonly llm: MockLLM,
    private readonly matchAssistantActions: (text: string) => MockUserAction[],
  ) {
    registrations.set(
      this,
      piAi.registerFauxProvider({
        api: FAUX_MODEL.api,
        provider: FAUX_PROVIDER,
        tokenSize: { min: 1, max: 1 },
        models: [
          {
            id: FAUX_MODEL.id,
            name: FAUX_MODEL.name,
            reasoning: FAUX_MODEL.reasoning,
            input: [...FAUX_MODEL.input],
            cost: FAUX_MODEL.cost,
            contextWindow: FAUX_MODEL.contextWindow,
            maxTokens: FAUX_MODEL.maxTokens,
          },
        ],
      }),
    );
  }

  private readonly recordedPrompts: PromptMessage[][] = [];
  private lastLoopKey = "";
  private consecutiveSameResponses = 0;

  /** Role/text/stopReason of the messages in the most recent LLM stream. */
  get lastPromptMessages(): PromptMessage[] | undefined {
    return this.recordedPrompts[this.recordedPrompts.length - 1];
  }

  stream(model: Model<string>, context: Context, options?: SimpleStreamOptions) {
    this.recordedPrompts.push(
      context.messages.map((message) => ({
        role: message.role,
        text: extractTextContent(message.content, "") ?? "",
        ...(message.role === "assistant" && message.stopReason
          ? { stopReason: message.stopReason }
          : {}),
      })),
    );

    const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
    const promptText = extractTextContent(lastUser?.content ?? "") ?? "";
    const responses = this.llm.matchPrompt(promptText);

    this.detectNoProgressLoop(context, promptText, responses);

    const registration = registrations.get(this);
    if (!registration) throw new Error("Faux provider registration missing.");

    const message = maybeRewriteAssistantEsc(
      makeAssistantMessage(responses),
      this.matchAssistantActions,
    );
    registration.setResponses([message]);

    return piAi.streamSimple(model, context, options);
  }

  /**
   * Guard against the Aug-2026 hang: the last-user lookup skips toolResult
   * messages, so a rule bound to an old user message matches forever and the
   * agent loops on the same tool call at full CPU with no timeout. Fail fast
   * with a visible error instead of hanging the test process.
   */
  private detectNoProgressLoop(
    context: Context,
    promptText: string,
    responses: MockLLMDescriptor[],
  ): void {
    const lastMessage = context.messages[context.messages.length - 1];
    // Inside one agent turn, every LLM call after the first is preceded by a
    // toolResult (the executed tool's output). A fresh user message means a
    // new turn — repeated identical prompts across turns are legitimate.
    const insideTurn = lastMessage?.role === "toolResult";
    const key = `${promptText}\n${JSON.stringify(responses)}`;

    if (insideTurn && key === this.lastLoopKey) {
      this.consecutiveSameResponses += 1;
      // Max 3 consecutive identical (prompt, responses) pairs inside one turn
      // before declaring a no-progress loop: real turns append a toolResult
      // after each tool execution, so a mock returning the same response to
      // the same prompt is stuck.
      if (this.consecutiveSameResponses >= 3) {
        throw new Error(
          `MockLLM loop detected: prompt rule "${promptText}" returned the same ` +
            `responses ${this.consecutiveSameResponses} consecutive times inside one turn. ` +
            "The agent would loop forever on this tool call - fix the prompt rules or the tool's terminate behavior.",
        );
      }
    } else {
      this.consecutiveSameResponses = 0;
    }
    this.lastLoopKey = key;
  }

  unregister(): void {
    const registration = registrations.get(this);
    if (!registration) return;
    registration.unregister();
    registrations.delete(this);
  }
}

function maybeRewriteAssistantEsc(
  message: AssistantMessage,
  matchAssistantActions: (text: string) => MockUserAction[],
): AssistantMessage {
  const visibleText = extractTextContent(message.content, "") ?? "";
  const shouldAbort = matchAssistantActions(visibleText).some(
    (action) => action.type === "user-esc",
  );

  if (!shouldAbort) return message;

  return piAi.fauxAssistantMessage("", { stopReason: "aborted" });
}

function makeAssistantMessage(responses: MockLLMDescriptor[]): AssistantMessage {
  const content = responses.map((descriptor, index) => {
    switch (descriptor.type) {
      case "response:text":
        return piAi.fauxText(descriptor.text);
      case "response:thinking":
        return piAi.fauxThinking(descriptor.text);
      case "response:push-task":
        return piAi.fauxToolCall(
          "push-task",
          {
            title: descriptor.title,
            prompt: descriptor.prompt,
          },
          { id: `call-${index + 1}` },
        );
    }
  });

  return piAi.fauxAssistantMessage(content, {
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  });
}
