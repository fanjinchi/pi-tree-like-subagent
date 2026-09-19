import assert from "node:assert";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assistant,
  pushTask,
  responds,
  task,
  taskResult,
  TestHarness,
  user,
} from "./test-helpers/index.js";

import { findOwnSkillFile, MAX_INLINED_ROLE_SKILLS, setSkills } from "./index.js";

import type { Skill } from "@earendil-works/pi-coding-agent";

describe("findOwnSkillFile depth cap", () => {
  it("resolves within the package (depth <= 2) and never picks up ancestor skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-skills-"));
    try {
      // startDir mirrors the source layout: <root>/pkg/src with skills/ at
      // the package root (<root>/pkg/skills). An unrelated ancestor dir
      // also carries a same-named skill — it must never be resolved.
      await mkdir(join(root, "pkg", "skills", "foo"), { recursive: true });
      await mkdir(join(root, "skills", "foo"), { recursive: true });
      await writeFile(join(root, "pkg", "skills", "foo", "SKILL.md"), "pkg copy");
      await writeFile(join(root, "skills", "foo", "SKILL.md"), "ancestor copy");

      const startDir = join(root, "pkg", "src");
      assert.strictEqual(
        findOwnSkillFile("foo", startDir),
        join(root, "pkg", "skills", "foo", "SKILL.md"),
      );

      // Without the in-package copy, the ancestor copy must stay unresolved:
      // the cap stops the walk at the package root instead of escaping it.
      await rm(join(root, "pkg", "skills", "foo", "SKILL.md"));
      assert.strictEqual(findOwnSkillFile("foo", startDir), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
      h.assertLastNotification("Task stored. Start it with `/start-task` or `/auto`.");
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
        "Warning: /skill:nonexistent were not resolved.\nTask stored. Start it with `/start-task` or `/auto`.",
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
        "Warning: /skill:foo, /skill:bar were not resolved.\nTask stored. Start it with `/start-task` or `/auto`.",
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

      // The delivered prompt carries the role skill content inline. The card's
      // own frontmatter mention of /skill:task-review is rewritten to the path
      // as well, and the OCR skill it references is neither registered nor
      // bundled here, so the branch is told about that unresolved nested ref.
      h.assertSessionContains(
        user(
          `Review the changes ${skillPath}.\n\n==== Task role skill: task-review ====\n${skillContent.replaceAll("/skill:task-review", skillPath)}\n\nNote: /skill:open-code-review-delegate (referenced by task-review) was not found.`,
        ),
        assistant("Findings: none."),
      );

      await h.prompt("/finish-task");
      h.assertSessionContains(taskResult("role task", "Findings: none."), assistant("Thanks."));
    } finally {
      h.dispose();
    }
  });

  it("keeps unknown names unchanged when the registry is empty", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt("work", pushTask("no skills at all", "Use /skill:zzz-no-such-skill."));
    try {
      setSkills([]);
      await h.prompt("work");

      h.assertSessionContains(task("no skills at all", "Use /skill:zzz-no-such-skill."));
      h.assertLastNotification(
        "Warning: /skill:zzz-no-such-skill were not resolved.\nTask stored. Start it with `/start-task` or `/auto`.",
      );
    } finally {
      h.dispose();
    }
  });

  it("falls back to the extension's own skills dir when the registry is empty", async () => {
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
      // Simulate Pi failing to load the role skill: empty registry (no
      // before_agent_start priming). Resolution must still succeed via the
      // extension's own bundled skills directory.
      setSkills([]);
      await h.prompt("main work");
      await h.prompt("/start-task");

      // The delivered prompt carries the role skill content inline, resolved
      // from the extension's own skills directory. The nested OCR ref stays
      // unresolved here (no registry, no bundled copy) and is reported.
      h.assertSessionContains(
        user(
          `Review the changes ${skillPath}.\n\n==== Task role skill: task-review ====\n${skillContent.replaceAll("/skill:task-review", skillPath)}\n\nNote: /skill:open-code-review-delegate (referenced by task-review) was not found.`,
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

describe("transitive role skill resolution", () => {
  const fixtureSkill = (name: string, filePath: string): Skill => ({
    name,
    description: `${name} test skill`,
    filePath,
    baseDir: dirname(filePath),
    sourceInfo: { path: filePath, source: "project", scope: "project", origin: "package" },
    disableModelInvocation: true,
  });

  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  /** Text of the delivered prompt: the last user message the model received. */
  const deliveredPrompt = (h: TestHarness): string => {
    const lastUser = [...(h.lastPromptMessages() ?? [])]
      .reverse()
      .find((message) => message.role === "user");
    assert.ok(lastUser, "expected a delivered user prompt");
    return lastUser.text;
  };

  /** Write one fixture SKILL.md per entry and return the matching Skill records. */
  const writeSkills = async (root: string, bodies: Record<string, string>): Promise<Skill[]> => {
    const written: Skill[] = [];
    for (const [name, body] of Object.entries(bodies)) {
      const dir = join(root, name);
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, "SKILL.md");
      await writeFile(filePath, body);
      written.push(fixtureSkill(name, filePath));
    }
    return written;
  };

  it("inlines a role skill referenced from inside another role skill", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-nested-skill-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nDelegate the review with /skill:nested-b.\n";
      const bBody = "# B\n\nNESTED-BODY-B: review each file.\n";
      const fixtures = await writeSkills(root, { "nested-a": aBody, "nested-b": bBody });
      const bPath = fixtures[1].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("nested role", "NESTED-TASK: review with /skill:nested-a."),
      );
      h.llm.onPrompt("NESTED-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      // The nested skill is inlined too, and the inlined copy of A carries the
      // rewritten path — no dead /skill: token reaches the branch.
      const delivered = deliveredPrompt(h);
      assert.ok(
        delivered.includes(
          `==== Task role skill: nested-a ====\n${aBody.replace("/skill:nested-b", bPath)}`,
        ),
        delivered,
      );
      assert.ok(delivered.includes(`==== Task role skill: nested-b ====\n${bBody}`), delivered);
      assert.ok(!delivered.includes("/skill:nested-b"), delivered);
      assert.ok(!delivered.includes("was not found"), delivered);
      h.assertSessionContains(assistant("Findings: none."));
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inlines each role skill once when two skills reference each other", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-mutual-skill-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nStart with /skill:mutual-b.\n";
      const bBody = "# B\n\nBack to /skill:mutual-a.\n";
      const fixtures = await writeSkills(root, { "mutual-a": aBody, "mutual-b": bBody });
      const aPath = fixtures[0].filePath;
      const bPath = fixtures[1].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("mutual roles", "MUTUAL-TASK: use /skill:mutual-a."),
      );
      h.llm.onPrompt("MUTUAL-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.strictEqual(count(delivered, "==== Task role skill: mutual-a ===="), 1, delivered);
      assert.strictEqual(count(delivered, "==== Task role skill: mutual-b ===="), 1, delivered);
      // A's own body was rewritten against its reference to B as well.
      assert.ok(delivered.includes(aBody.replace("/skill:mutual-b", bPath)), delivered);
      // B's body was rewritten against its own reference to A.
      assert.ok(delivered.includes(bBody.replace("/skill:mutual-a", aPath)), delivered);
      assert.ok(!delivered.includes("/skill:mutual-"), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a nested ref that resolves to nothing instead of failing the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-ghost-skill-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nDelegate with /skill:ghost-skill.\n";
      const fixtures = await writeSkills(root, { "ghost-a": aBody });

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("ghost role", "GHOST-TASK: use /skill:ghost-a."),
      );
      h.llm.onPrompt("GHOST-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // An unresolved nested ref stays literal and is called out once, so the
      // branch knows the skill is missing rather than silently skipping it.
      assert.ok(delivered.includes(`==== Task role skill: ghost-a ====\n${aBody}`), delivered);
      assert.ok(
        delivered.endsWith("Note: /skill:ghost-skill (referenced by ghost-a) was not found."),
        delivered,
      );
      h.assertSessionContains(assistant("Findings: none."));
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it(`stops inlining after ${MAX_INLINED_ROLE_SKILLS} sections`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-cap-skill-"));
    const h = await TestHarness.create();
    try {
      // A five-link chain: each skill references the next one.
      const bodies: Record<string, string> = {};
      for (let index = 0; index < MAX_INLINED_ROLE_SKILLS + 1; index += 1) {
        bodies[`cap-${index}`] =
          index < MAX_INLINED_ROLE_SKILLS
            ? `# cap-${index}\n\nNext: /skill:cap-${index + 1}.\n`
            : `# cap-${index}\n\nLeaf body.\n`;
      }
      const fixtures = await writeSkills(root, bodies);

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("cap roles", "CAP-TASK: use /skill:cap-0."),
      );
      h.llm.onPrompt("CAP-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.strictEqual(
        count(delivered, "==== Task role skill: "),
        MAX_INLINED_ROLE_SKILLS,
        delivered,
      );
      assert.ok(
        !delivered.includes(`==== Task role skill: cap-${MAX_INLINED_ROLE_SKILLS} ====`),
        delivered,
      );
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
// Actual file existence is not required — resolution is pure string replacement.
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
    description:
      "Role card for review tasks queued via push-task: independent review of code or a plan, no author bias",
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
    description:
      "Role card for research tasks queued via push-task: self-contained investigation, report is the only deliverable",
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
    description:
      "Role card for implementation tasks queued via push-task: build from the plan, report change list and verification",
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
  description:
    "Role card for review tasks queued via push-task: independent review of code or a plan, no author bias",
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
