import { stripVTControlCharacters } from "node:util";

import type { Component, TUI } from "@earendil-works/pi-tui";
import { Theme } from "@earendil-works/pi-coding-agent";

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export class TestUi {
  #lastNotification: string | undefined;
  #lastStatus: string | undefined;
  #lastStatusRaw: string | undefined;
  #lastWidget: string[] | undefined;

  readonly context: ExtensionUIContext = {
    ...noOpContext,
    notify: (message: string) => {
      this.#lastNotification = normalizeText(message);
    },
    setStatus: (key: string, value: string | undefined) => {
      if (key !== "task") return;
      // Capture before normalization so tests can assert ANSI styling survived.
      this.#lastStatusRaw = value;
      this.#lastStatus = normalizeText(value);
    },
    setWidget: (
      key: string,
      content:
        | string[]
        | ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
        | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) => {
      if (key !== "task-branch") return;
      // Fail fast on stub/real-TUI divergence: the extension must stay on the
      // string-array, aboveEditor contract, otherwise the stub would silently
      // mis-model the real setWidget. undefined is the official clear signal.
      if (content !== undefined && !Array.isArray(content))
        throw new Error("test stub: expected string[] setWidget content");
      if (options?.placement && options.placement !== "aboveEditor")
        throw new Error("test stub: unexpected widget placement");
      const lines = (content ?? []).map(normalizeText).filter((line) => line !== undefined);
      this.#lastWidget = lines.length > 0 ? lines : undefined;
    },
  };

  get lastStatus(): string | undefined {
    return this.#lastStatus;
  }

  /** Raw status value before ANSI stripping; asserts that styling was applied. */
  get lastStatusRaw(): string | undefined {
    return this.#lastStatusRaw;
  }

  get lastNotification(): string | undefined {
    return this.#lastNotification;
  }

  /** Task-branch widget lines (normalized), or undefined when cleared. */
  get lastWidget(): string[] | undefined {
    return this.#lastWidget;
  }
}

function normalizeText(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const result = stripVTControlCharacters(value).trim();
  return result === "" ? undefined : result;
}

const noOpContext: ExtensionUIContext = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
  notify() {},
  onTerminalInput() {
    return () => {};
  },
  setStatus() {},
  setWorkingMessage() {},
  setWorkingVisible() {},
  setWorkingIndicator() {},
  setHiddenThinkingLabel() {},
  setWidget() {},
  setFooter() {},
  setHeader() {},
  setTitle() {},
  async custom() {
    return undefined as never;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() {
    return "";
  },
  async editor() {
    return undefined;
  },
  addAutocompleteProvider() {},
  setEditorComponent() {},
  getEditorComponent() {
    return undefined;
  },
  theme: new Theme(
    {
      accent: 0,
      border: 0,
      borderAccent: 0,
      borderMuted: 0,
      success: 0,
      error: 0,
      warning: 0,
      muted: 0,
      dim: 0,
      text: 0,
      thinkingText: 0,
      userMessageText: 0,
      customMessageText: 0,
      customMessageLabel: 0,
      toolTitle: 0,
      toolOutput: 0,
      mdHeading: 0,
      mdLink: 0,
      mdLinkUrl: 0,
      mdCode: 0,
      mdCodeBlock: 0,
      mdCodeBlockBorder: 0,
      mdQuote: 0,
      mdQuoteBorder: 0,
      mdHr: 0,
      mdListBullet: 0,
      toolDiffAdded: 0,
      toolDiffRemoved: 0,
      toolDiffContext: 0,
      syntaxComment: 0,
      syntaxKeyword: 0,
      syntaxFunction: 0,
      syntaxVariable: 0,
      syntaxString: 0,
      syntaxNumber: 0,
      syntaxType: 0,
      syntaxOperator: 0,
      syntaxPunctuation: 0,
      thinkingOff: 0,
      thinkingMinimal: 0,
      thinkingLow: 0,
      thinkingMedium: 0,
      thinkingHigh: 0,
      thinkingXhigh: 0,
      bashMode: 0,
    },
    {
      selectedBg: 0,
      userMessageBg: 0,
      customMessageBg: 0,
      toolPendingBg: 0,
      toolSuccessBg: 0,
      toolErrorBg: 0,
    },
    "truecolor",
  ),
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: false, error: "Theme switching not supported in tests." };
  },
  getToolsExpanded() {
    return false;
  },
  setToolsExpanded() {},
};
