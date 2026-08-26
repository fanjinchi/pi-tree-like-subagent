import type {
  SessionEntry as PiSessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { taskQuestionInstructions, taskQuestionMarker, taskResultMarker } from "../index.js";
import { extractTextContent, type TextBlock } from "../text-content.js";

export class TestSession {
  constructor(private readonly sessionManager: SessionManager) {}

  entries(): SessionEntry[] {
    return sessionEntries(this.sessionManager.getBranch());
  }

  allEntries(): SessionEntry[] {
    return sessionEntries(this.sessionManager.getEntries());
  }
}

export type SessionEntry =
  | ReturnType<typeof user>
  | ReturnType<typeof assistant>
  | ReturnType<typeof assistantAborted>
  | ReturnType<typeof task>
  | ReturnType<typeof taskResult>
  | ReturnType<typeof taskQuestion>;

// ---------------------------------------------------------------------------
// Descriptor constructors
// ---------------------------------------------------------------------------

export const user = (content: string) => ({
  type: "message" as const,
  message: {
    role: "user" as const,
    content: [textBlock(content)],
  },
});

export const assistant = (content: string, stopReason?: string) => ({
  type: "message" as const,
  message: {
    role: "assistant" as const,
    content: [textBlock(content)],
    ...(stopReason ? { stopReason } : {}),
  },
});

export const assistantAborted = () => assistant("", "aborted");

export const task = (title: string, prompt: string) => ({
  type: "custom" as const,
  customType: "task" as const,
  data: { title, prompt },
});

export const taskResult = (title: string, content?: string) => ({
  type: "custom_message" as const,
  customType: "task-result" as const,
  details: { title },
  ...(content !== undefined ? { content: [textBlock(content)] } : {}),
});

export const taskQuestion = (title: string, question?: string) => ({
  type: "custom_message" as const,
  customType: "task-question" as const,
  details: { title },
  ...(question !== undefined ? { content: [textBlock(question)] } : {}),
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sessionEntries(entries: PiSessionEntry[]): SessionEntry[] {
  const result: SessionEntry[] = [];

  for (const entry of entries) {
    switch (entry.type) {
      case "thinking_level_change":
      case "model_change":
      case "session_info":
      case "label":
        break;
      case "message":
        if (entry.message.role === "user") {
          result.push(user(textContent(entry.message.content)));
        } else if (entry.message.role === "assistant") {
          result.push(
            assistant(
              textContent(entry.message.content),
              visibleStopReason(entry.message.stopReason),
            ),
          );
        }
        break;
      case "custom":
        if (entry.customType === "task" && isTaskData(entry.data)) {
          result.push(task(entry.data.title, entry.data.prompt));
        }
        break;
      case "custom_message":
        if (entry.customType === "task-result" && hasTitle(entry.details)) {
          // Strip the "[task-result: <title>]" marker the plugin injects on
          // delivery, so descriptors compare against the raw result content.
          const raw = textContent(entry.content);
          const marker = taskResultMarker(entry.details.title);
          const content = raw.startsWith(marker) ? raw.slice(marker.length) : raw;
          result.push(taskResult(entry.details.title, content || undefined));
        } else if (entry.customType === "task-question" && hasTitle(entry.details)) {
          // Strip the "[task-question: <title>]" marker and the relay
          // instructions appended after the question, so descriptors compare
          // against the raw question text.
          const raw = textContent(entry.content);
          const marker = taskQuestionMarker(entry.details.title);
          let content = raw.startsWith(marker) ? raw.slice(marker.length) : raw;
          const instructionsAt = content.indexOf(taskQuestionInstructions);
          if (instructionsAt >= 0) content = content.slice(0, instructionsAt).trimEnd();
          result.push(taskQuestion(entry.details.title, content || undefined));
        }
        break;
    }
  }

  return result;
}

const textBlock = (text: string): TextBlock => ({ type: "text", text });

function textContent(content: unknown): string {
  return extractTextContent(content, "") ?? "";
}

function visibleStopReason(stopReason: unknown): string | undefined {
  return typeof stopReason === "string" && stopReason !== "stop" ? stopReason : undefined;
}

function isTaskData(value: unknown): value is { title: string; prompt: string } {
  return isRecord(value) && typeof value.title === "string" && typeof value.prompt === "string";
}

function hasTitle(value: unknown): value is { title: string } {
  return isRecord(value) && typeof value.title === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
