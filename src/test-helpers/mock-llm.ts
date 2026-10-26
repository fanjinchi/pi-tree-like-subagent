import type { JsonObject } from "@earendil-works/pi-ai";

export class MockLLM {
  private readonly promptRules: PromptRule[] = [];

  onPrompt(text: string, ...responses: MockLLMDescriptor[]): void {
    this.promptRules.push({ text, rounds: [responses], nextRound: 0 });
  }

  /**
   * Like onPrompt, but each consecutive match consumes the next round of
   * responses. Needed when a tool call deterministically fails (e.g. a
   * branch guard) and the follow-up turn inside the same agent loop must
   * answer differently. Once the rounds are exhausted the rule no longer
   * matches (later rules or the no-match error apply).
   */
  onPromptSequence(text: string, rounds: MockLLMDescriptor[][]): void {
    if (rounds.length === 0) {
      throw new Error("onPromptSequence requires at least one round.");
    }
    this.promptRules.push({ text, rounds, nextRound: 0 });
  }

  matchPrompt(text: string): MockLLMDescriptor[] {
    const matched = this.promptRules.find((rule) => {
      if (rule.rounds.length > 1 && rule.nextRound >= rule.rounds.length) return false;
      if (rule.text === "") return text === "";
      return text.includes(rule.text);
    });

    if (!matched) {
      throw new Error(`No MockLLM rule matched provider prompt: ${text || "<empty prompt>"}`);
    }

    if (matched.rounds.length === 1) return [...matched.rounds[0]];
    return [...matched.rounds[matched.nextRound++]];
  }
}

export type MockLLMDescriptor =
  | ReturnType<typeof responds>
  | ReturnType<typeof thinks>
  | ReturnType<typeof fails>
  | ReturnType<typeof pushTask>
  | ReturnType<typeof resumeTask>
  | ReturnType<typeof callsTool>;

export const responds = (text: string) => ({
  type: "response:text" as const,
  text,
});

/**
 * A turn that fails the way exhausted retries do: pi appends an assistant
 * message with an empty content array and stopReason "error". Use it to
 * exercise the interruption paths (no report to deliver). Tests that expect
 * one must opt in with `TestHarness.create({ allowAssistantErrors: true })`,
 * otherwise the harness flags the error entry as an unexpected provider fault.
 */
export const fails = (errorMessage: string) => ({
  type: "response:error" as const,
  errorMessage,
});

export const thinks = (text: string) => ({
  type: "response:thinking" as const,
  text,
});

export const pushTask = (title: string, prompt: string, fork?: boolean) => ({
  type: "response:push-task" as const,
  title,
  prompt,
  ...(fork ? { fork: true } : {}),
});

export const resumeTask = (title: string | undefined, message: string) => ({
  type: "response:resume-task" as const,
  title,
  message,
});

/**
 * A plain tool call for tools the harness has no dedicated descriptor for
 * (e.g. list-tasks). The call keeps the turn going, so a test that wants a
 * following reply should register the next round with onPromptSequence.
 */
export const callsTool = (name: string, args: JsonObject = {}) => ({
  type: "response:tool-call" as const,
  name,
  args,
});

type PromptRule = {
  text: string;
  rounds: MockLLMDescriptor[][];
  nextRound: number;
};
