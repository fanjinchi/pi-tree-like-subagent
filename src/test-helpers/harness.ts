import assert from "node:assert";

import {
  getCurrentSystemMessage,
  getSystemMessageText,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";

import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionContext,
  type ExtensionError,
  type InputSource,
  type SessionEntry,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line unslop/import-control -- extension factory not available via src test-helpers import chain
import registerSuperGsd from "../../index.js";

import { isDeepStrictEqual } from "node:util";

import { extractTextContent } from "../text-content.js";

import { type SessionEntry as TestSessionEntry, TestSession } from "./test-session.js";

import { whenAutoParked } from "../index.js";

import { TestUi } from "./test-ui.js";

import { FAUX_MODEL, FAUX_PROVIDER, FauxProvider, type PromptMessage } from "./faux-provider.js";

import { MockLLM } from "./mock-llm.js";

import { MockUser, type MockUserAction } from "./mock-user.js";

export interface TestHarnessOptions {
  /**
   * Reason reported by the session_start frame emitted at bind time. Defaults
   * to "resume" — the harness acts like a restored / non-fresh session, so
   * /auto is never synthesized; that is the behavior all pre-existing tests
   * assume. Pass `{ type: "session_start", reason: "startup" }` to simulate
   * a production launch's first frame and exercise default-on auto.
   */
  sessionStartEvent?: SessionStartEvent;
  /**
   * Extension mode reported on every extension context (`ctx.mode`).
   * Defaults to "tui": the boundary drain only engages outside TUI mode, so
   * pre-existing tests keep the tree/navigation semantics they were written
   * against. Pass "rpc" to exercise the in-run boundary drain.
   */
  mode?: ExtensionMode;
  /**
   * Runs after the in-memory SessionManager exists but before the session
   * boots, i.e. before the session_start frame is emitted. Use it to
   * simulate a restored transcript (`--session`): only Pi-produced entries
   * (user/assistant messages) belong here, never task state.
   */
  seedSession?: (sessionManager: SessionManager) => void;
}

export class TestHarness {
  private constructor(
    readonly llm: MockLLM,
    readonly user: MockUser,
    private readonly session: AgentSession,
    private readonly sessionManager: SessionManager,
    private readonly testSession: TestSession,
    private readonly testUi: TestUi,
    private readonly fauxProvider: FauxProvider,
    private handledSessionEntryIds = new Set<string>(),
  ) {}

  readonly extensionErrors: ExtensionError[] = [];

  /** Number of public `agent_settled` events observed this session. */
  private settled = 0;

  private readonly onSessionEvent = (event: AgentSessionEvent): void => {
    if (event.type === "agent_settled") this.settled += 1;
  };

  get modelRegistry(): ModelRegistry {
    // ModelRegistry is a thin synchronous facade over the session's runtime.
    return new ModelRegistry(this.session.modelRuntime);
  }

  static async create(options: TestHarnessOptions = {}): Promise<TestHarness> {
    const cwd = process.cwd();
    const agentDir = getAgentDir();
    // pi 0.87.1 builds the model/auth runtime instead of a bare registry: an
    // in-memory credential store keeps tests off ~/.pi/agent, and with no
    // modelsPath nothing is read from or written to disk.
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const sessionManager = SessionManager.inMemory(cwd);
    options.seedSession?.(sessionManager);
    const llm = new MockLLM();
    const user = new MockUser();
    const fauxProvider = new FauxProvider(llm, (text) => user.matchAssistant(text));
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.registerProvider(FAUX_PROVIDER, {
            api: FAUX_MODEL.api,
            baseUrl: FAUX_MODEL.baseUrl,
            apiKey: "test-key",
            streamSimple: (model, context, options) => fauxProvider.stream(model, context, options),
            models: [
              {
                id: FAUX_MODEL.id,
                name: FAUX_MODEL.name,
                api: FAUX_MODEL.api,
                baseUrl: FAUX_MODEL.baseUrl,
                reasoning: FAUX_MODEL.reasoning,
                thinkingLevelMap: FAUX_MODEL.thinkingLevelMap,
                input: [...FAUX_MODEL.input],
                cost: FAUX_MODEL.cost,
                contextWindow: FAUX_MODEL.contextWindow,
                maxTokens: FAUX_MODEL.maxTokens,
              },
            ],
          });
        },
        registerSuperGsd,
      ],
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
      model: FAUX_MODEL,
      thinkingLevel: "off" as const,
      noTools: "builtin",
      // Default to a non-fresh frame: pre-existing tests must never see the
      // synthesized /auto. "resume" is a legal reason (types.d.ts) and
      // matches the harness acting as a restored session.
      sessionStartEvent: options.sessionStartEvent ?? {
        type: "session_start",
        reason: "resume",
      },
    });

    const testSession = new TestSession(sessionManager);
    const testUi = new TestUi();
    // No sendUserMessage patch needed: pi 0.87.1+ forwards expandPromptTemplates
    // natively and defers prompts emitted mid-settle (they run after the
    // agent_settled emission finishes), so the harness drives the same
    // extension-command dispatch the running app performs.

    const harness = new TestHarness(
      llm,
      user,
      session,
      sessionManager,
      testSession,
      testUi,
      fauxProvider,
    );

    await session.bindExtensions({
      uiContext: harness.testUi.context,
      mode: options.mode ?? "tui",
      commandContextActions: harness.commandContextActions(),
      onError: (error: ExtensionError) => {
        harness.extensionErrors.push(error);
      },
      shutdownHandler: () => {
        // No-op: we don't want extension shutdown to terminate the process.
      },
    });
    session.subscribe(harness.onSessionEvent);
    return harness;
  }

  assertExtensionError(text: string): void {
    const last = this.extensionErrors[this.extensionErrors.length - 1];
    assert.ok(last, `expected an extension error containing ${JSON.stringify(text)}, got none`);
    assert.ok(
      last.error.includes(text),
      `expected extension error to contain ${JSON.stringify(text)}, got ${JSON.stringify(last.error)}`,
    );
  }

  settledCount(): number {
    return this.settled;
  }

  async promptFollowUp(text: string): Promise<void> {
    // session.prompt evaluates isStreaming at call time; racing the run's
    // startup would take the non-streaming path and collide with the active
    // run. Wait for agent_start first (no-op when already streaming).
    if (!this.session.isStreaming) {
      await new Promise<void>((resolve) => {
        const unsubscribe = this.session.subscribe((event) => {
          if (event.type === "agent_start") {
            unsubscribe();
            resolve();
          }
        });
      });
    }
    await this.session.prompt(text, {
      streamingBehavior: "followUp",
      source: "test" as InputSource,
    });
  }

  dispose(): void {
    this.fauxProvider.unregister();
    this.session.dispose();
  }

  assertStatus(expected?: string): void {
    assert.strictEqual(this.testUi.lastStatus, expected);
  }

  assertWidget(expected?: string[]): void {
    assert.deepStrictEqual(this.testUi.lastWidget, expected);
  }

  get lastStatusRaw(): string | undefined {
    return this.testUi.lastStatusRaw;
  }

  assertLastNotification(expected: string | undefined): void {
    assert.strictEqual(this.testUi.lastNotification, expected);
  }

  assertModel(expected: string): void {
    const current = this.session.model;
    assert.ok(current, "Expected a model to be set, but none is active.");
    const got = `${current.provider}/${current.id}`;
    assert.strictEqual(got, expected, `Expected model ${expected}, got ${got}`);
  }

  assertSession(...expected: TestSessionEntry[]): void {
    assert.deepStrictEqual(this.testSession.entries(), expected);
  }

  appendCustomEntry(customType: string, data: unknown): void {
    this.sessionManager.appendCustomEntry(customType, data);
  }

  appendAbortedAssistantTurn(): void {
    this.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: FAUX_MODEL.api,
      provider: FAUX_MODEL.provider,
      model: FAUX_MODEL.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "aborted",
      timestamp: Date.now(),
    });
  }

  lastPromptMessages(): PromptMessage[] | undefined {
    return this.fauxProvider.lastPromptMessages;
  }

  promptHistory(): readonly PromptMessage[][] {
    return this.fauxProvider.promptHistory;
  }

  assertSessionContains(...expected: TestSessionEntry[]): void {
    const actual = this.testSession.allEntries();
    for (const expectedEntry of expected) {
      assert.ok(
        actual.some((entry) => isDeepStrictEqual(entry, expectedEntry)),
        `Expected session to contain entry: ${JSON.stringify(expectedEntry)}`,
      );
    }
  }

  async waitForIdle(): Promise<void> {
    await this.scanAndReactLoop();
  }

  async waitForAutoParked(): Promise<void> {
    await whenAutoParked(this.sessionManager);
  }

  registeredToolNames(): string[] {
    return this.session
      .getAllTools()
      .map((tool) => tool.name)
      .sort();
  }

  activeToolNames(): string[] {
    return this.session.getActiveToolNames().slice().sort();
  }

  systemPromptText(): string {
    const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
    return current ? getSystemMessageText(current) : "";
  }

  setActiveToolNames(names: string[]): void {
    this.session.setActiveToolsByName(names);
  }

  countBranchCustomEntries(customType: string): number {
    return this.sessionManager.getBranch().filter((entry) => isCustomType(entry, customType))
      .length;
  }

  branchCustomEntryIds(customType: string): string[] {
    return this.sessionManager
      .getBranch()
      .filter((entry) => isCustomType(entry, customType))
      .map((entry) => entry.id);
  }

  countAllCustomEntries(customType: string): number {
    return this.sessionManager.getEntries().filter((entry) => isCustomType(entry, customType))
      .length;
  }

  branchCustomData(customType: string): unknown[] {
    return this.sessionManager
      .getBranch()
      .filter((entry) => isCustomType(entry, customType))
      .map((entry) => (entry as { data?: unknown }).data);
  }

  private commandContextActions() {
    return {
      waitForIdle: async () => {
        await this.scanAndReactLoop();
      },
      navigateTree: async (
        targetId: string,
        options?: Parameters<AgentSession["navigateTree"]>[1],
      ) => this.session.navigateTree(targetId, options),
      newSession: async () => ({ cancelled: false }),
      fork: async () => ({ cancelled: false }),
      switchSession: async () => ({ cancelled: false }),
      reload: async () => {
        await this.session.reload();
      },
    };
  }

  private async scanAndReactLoop(): Promise<void> {
    await flushMicrotasks();
    await this.session.agent.waitForIdle();
    // pi 0.87.1 keeps isStreaming true until the settle emission (and its
    // deferred prompts) finish. Agent-level idle alone lets a reaction prompt
    // fire too early (session.prompt throws while streaming) and lets the
    // supervisor loop navigate too early (navigateTree throws too). Only the
    // session-level idle promise covers the settle window.
    await this.session.waitForIdle();

    let reacted: boolean;
    do {
      reacted = false;
      for (const entry of this.sessionManager.getBranch()) {
        if (this.handledSessionEntryIds.has(entry.id)) continue;
        this.handledSessionEntryIds.add(entry.id);

        if (entry.type === "message" && entry.message.role === "assistant") {
          const text = extractTextContent(entry.message.content, "") ?? "";
          for (const action of this.user.matchAssistant(text)) {
            if (action.type === "user-esc") continue;
            await this.applyUserAction(action);
            reacted = true;
          }
          continue;
        }

        if (!isTaskEntryData(entry)) continue;
        for (const action of this.user.matchQueuedTask(entry.data.prompt)) {
          await this.applyUserAction(action);
          reacted = true;
        }
      }

      if (reacted) {
        await flushMicrotasks();
      }
    } while (reacted);
  }

  private async applyUserAction(action: MockUserAction): Promise<void> {
    switch (action.type) {
      case "user-ctrl-c":
        await this.session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        return;
      case "user-prompts":
        await this.prompt(action.text);
        return;
    }
  }

  async prompt(text: string): Promise<void> {
    const knownEntryIds = new Set(this.sessionManager.getEntries().map((entry) => entry.id));

    await this.session.prompt(text, {
      expandPromptTemplates: true,
      source: "test" as InputSource,
    });
    await this.session.agent.waitForIdle();
    // pi 0.87.1: agent runs triggered inside extension commands are dispatched
    // with their own settle cadence (deferred prompt queue flushed after the
    // command turn's settle emission), so the idles above can resolve before
    // the run's messages land on the branch. Drain until no new entries appear
    // for a full idle cycle, then do a final error sweep.
    for (let i = 0; i < 5; i++) {
      await this.session.agent.waitForIdle();
      await this.session.waitForIdle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.sessionManager.getEntries().every((entry) => knownEntryIds.has(entry.id))) {
        break;
      }
    }
    this.throwIfNewAssistantError(knownEntryIds);
  }

  private throwIfNewAssistantError(knownEntryIds: ReadonlySet<string>): void {
    const assistantError = this.sessionManager.getEntries().find((entry) => {
      if (knownEntryIds.has(entry.id)) return false;
      return (
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error"
      );
    });

    if (assistantError?.type === "message" && assistantError.message.role === "assistant") {
      throw new Error(assistantError.message.errorMessage ?? "Assistant turn failed.");
    }
  }
}

/** `ExtensionMode` is not re-exported from the package root (pi 0.87.1); extract it. */
type ExtensionMode = ExtensionContext["mode"];

function isTaskEntryData(entry: SessionEntry): entry is SessionEntry & {
  type: "custom";
  customType: "task";
  data: { title: string; prompt: string };
} {
  return (
    isCustomType(entry, "task") &&
    isRecord(entry.data) &&
    typeof entry.data.title === "string" &&
    typeof entry.data.prompt === "string"
  );
}

function isCustomType(
  entry: SessionEntry,
  customType: string,
): entry is SessionEntry & { type: "custom"; customType: string; data: unknown } {
  return entry.type === "custom" && entry.customType === customType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}
