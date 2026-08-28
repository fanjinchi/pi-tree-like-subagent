import assert from "node:assert";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

import {
  assistant,
  pushTask,
  responds,
  task,
  taskResult,
  TestHarness,
  user,
} from "./test-helpers/index.js";

import { setSkills } from "./index.js";

import type { Skill } from "@earendil-works/pi-coding-agent";

describe("push-task skill resolution", () => {
  it("leaves prompt unchanged when there are no skill refs", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("work", pushTask("no refs", "Do a thing with no skill refs."));
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(task("no refs", "Do a thing with no skill refs."));
    } finally {
      h.dispose();
    }
  });

  it("resolves a single /skill:name to its absolute path", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask("brainstorming review", "Review using /skill:brainstorming for ideas."),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(
        task(
          "brainstorming review",
          "Review using /dev/null/skills/brainstorming/SKILL.md for ideas.",
        ),
      );
      h.assertLastNotification("Task stored. Use `/start-task` or `/auto` to start it.");
    } finally {
      h.dispose();
    }
  });

  it("resolves multiple /skill:name refs", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask("multiple skills", "Use /skill:brainstorming then /skill:tdd for implementation."),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(
        task(
          "multiple skills",
          "Use /dev/null/skills/brainstorming/SKILL.md then /dev/null/skills/tdd/SKILL.md for implementation.",
        ),
      );
    } finally {
      h.dispose();
    }
  });

  it("resolves the same /skill:name appearing twice", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask("duplicate skill", "First /skill:brainstorming. Then more /skill:brainstorming."),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(
        task(
          "duplicate skill",
          "First /dev/null/skills/brainstorming/SKILL.md. Then more /dev/null/skills/brainstorming/SKILL.md.",
        ),
      );
    } finally {
      h.dispose();
    }
  });

  it("keeps unknown skill names unchanged - partial resolution", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask("partial unknown", "Use /skill:brainstorming and /skill:nonexistent."),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(
        task(
          "partial unknown",
          "Use /dev/null/skills/brainstorming/SKILL.md and /skill:nonexistent.",
        ),
      );
      h.assertLastNotification(
        "Warning: /skill:nonexistent were not resolved.\nTask stored. Use `/start-task` or `/auto` to start it.",
      );
    } finally {
      h.dispose();
    }
  });

  it("keeps all unknown skill names unchanged", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("work", pushTask("all unknown", "Use /skill:foo and /skill:bar."));
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(task("all unknown", "Use /skill:foo and /skill:bar."));
      h.assertLastNotification(
        "Warning: /skill:foo, /skill:bar were not resolved.\nTask stored. Use `/start-task` or `/auto` to start it.",
      );
    } finally {
      h.dispose();
    }
  });

  it("resolves the task role skills referenced by the guidelines", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask(
        "role example",
        "Review the changes: /skill:task-review. Then research: /skill:task-research. Then implement: /skill:task-implement.",
      ),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      h.assertSessionContains(
        task(
          "role example",
          "Review the changes: /dev/null/skills/task-review/SKILL.md. Then research: /dev/null/skills/task-research/SKILL.md. Then implement: /dev/null/skills/task-implement/SKILL.md.",
        ),
      );

      // The resolved skills are recorded on the task entry so /start-task can
      // inline their content into the delivered prompt.
      const tasks = h.branchCustomData("task") as Array<{
        skills?: Array<{ name: string; filePath: string }>;
      }>;
      assert.strictEqual(tasks.length, 1);
      assert.deepEqual(tasks[0].skills, [
        { name: "task-review", filePath: "/dev/null/skills/task-review/SKILL.md" },
        { name: "task-research", filePath: "/dev/null/skills/task-research/SKILL.md" },
        { name: "task-implement", filePath: "/dev/null/skills/task-implement/SKILL.md" },
      ]);
    } finally {
      h.dispose();
    }
  });

  it("inlines the resolved role skill into the delivered task prompt", async () => {
    const h = await TestHarness.create();
    const skillPath = new URL("../skills/task-review/SKILL.md", import.meta.url).pathname;
    const skillContent = await readFile(skillPath, "utf8");
    h.llm.onPrompt(
      "main work",
      responds("working..."),
      pushTask("role task", "Review the changes /skill:task-review."),
    );
    h.llm.onPrompt("Review the changes", responds("Findings: none."));
    h.llm.onPrompt("[task-result: role task]", responds("Thanks."));

    try {
      setSkills([TASK_REVIEW_SKILL]);
      await h.prompt("main work");
      await h.prompt("/start-task");

      // The delivered prompt carries the role skill content inline.
      h.assertSessionContains(
        user(
          `Review the changes ${skillPath}.\n\n==== Task role skill: task-review ====\n${skillContent}`,
        ),
        assistant("Findings: none."),
      );

      await h.prompt("/finish-task");
      h.assertSessionContains(taskResult("role task", "Findings: none."), assistant("Thanks."));
    } finally {
      h.dispose();
    }
  });
});

// Mock skill paths are project-relative for the test environment.
// Actual file existence is not required — resolution is pure string replacement.
const MOCK_SKILLS: Skill[] = [
  {
    name: "brainstorming",
    description: "Brainstorming ideas",
    filePath: "/dev/null/skills/brainstorming/SKILL.md",
    baseDir: "/dev/null/skills/brainstorming",
    sourceInfo: {
      path: "/dev/null/skills/brainstorming/SKILL.md",
      source: "project",
      scope: "project",
      origin: "package",
    },
    disableModelInvocation: false,
  },
  {
    name: "tdd",
    description: "Test-driven development",
    filePath: "/dev/null/skills/tdd/SKILL.md",
    baseDir: "/dev/null/skills/tdd",
    sourceInfo: {
      path: "/dev/null/skills/tdd/SKILL.md",
      source: "project",
      scope: "project",
      origin: "package",
    },
    disableModelInvocation: false,
  },
  {
    name: "task-review",
    description: "Role card for review tasks queued via push-task: independent review of code or a plan, no author bias",
    filePath: "/dev/null/skills/task-review/SKILL.md",
    baseDir: "/dev/null/skills/task-review",
    sourceInfo: {
      path: "/dev/null/skills/task-review/SKILL.md",
      source: "project",
      scope: "project",
      origin: "package",
    },
    disableModelInvocation: true,
  },
  {
    name: "task-research",
    description: "Role card for research tasks queued via push-task: self-contained investigation, report is the only deliverable",
    filePath: "/dev/null/skills/task-research/SKILL.md",
    baseDir: "/dev/null/skills/task-research",
    sourceInfo: {
      path: "/dev/null/skills/task-research/SKILL.md",
      source: "project",
      scope: "project",
      origin: "package",
    },
    disableModelInvocation: true,
  },
  {
    name: "task-implement",
    description: "Role card for implementation tasks queued via push-task: build from the plan, report change list and verification",
    filePath: "/dev/null/skills/task-implement/SKILL.md",
    baseDir: "/dev/null/skills/task-implement",
    sourceInfo: {
      path: "/dev/null/skills/task-implement/SKILL.md",
      source: "project",
      scope: "project",
      origin: "package",
    },
    disableModelInvocation: true,
  },
];

// Real role skill pointing at the actual SKILL.md so the start-task injection
// path can be tested end to end (the file content is read and inlined).
const TASK_REVIEW_SKILL: Skill = {
  name: "task-review",
  description: "Role card for review tasks queued via push-task: independent review of code or a plan, no author bias",
  filePath: new URL("../skills/task-review/SKILL.md", import.meta.url).pathname,
  baseDir: new URL("../skills/task-review", import.meta.url).pathname,
  sourceInfo: {
    path: new URL("../skills/task-review/SKILL.md", import.meta.url).pathname,
    source: "project",
    scope: "project",
    origin: "package",
  },
  disableModelInvocation: true,
};
