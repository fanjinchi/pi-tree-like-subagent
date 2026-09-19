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

  it("does not partially resolve a longer /skill: token", async () => {
    const h = await TestHarness.create();
    h.llm.onPrompt(
      "work",
      pushTask(
        "partial token",
        "Keep /skill:tdd--x as written. Use /skill:tdd, /skill:tdd. (/skill:tdd) `/skill:tdd` /skill:tdd?",
      ),
    );
    try {
      setSkills(MOCK_SKILLS);
      await h.prompt("work");

      // The name pattern cannot reach across `--`, and the boundary assertion
      // stops it from matching the `tdd` prefix inside a longer token: the
      // token is left alone rather than rewritten into a path with a `--x`
      // tail glued to it. Trailing punctuation after a whole name is not a
      // token boundary, so those refs still resolve.
      h.assertSessionContains(
        task(
          "partial token",
          "Keep /skill:tdd--x as written. Use /dev/null/skills/tdd/SKILL.md, /dev/null/skills/tdd/SKILL.md. (/dev/null/skills/tdd/SKILL.md) `/dev/null/skills/tdd/SKILL.md` /dev/null/skills/tdd/SKILL.md?",
        ),
      );
      // Nothing was queued as unresolved, so no warning is emitted either.
      h.assertLastNotification("Task stored. Start it with `/start-task` or `/auto`.");
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
      // A diamond that funnels cap-4 into the queue twice: cap-2 (inlined
      // third) references it next to cap-3, and cap-3 (inlined fourth)
      // references it again. The cap is reached before it can be inlined.
      const bodies: Record<string, string> = {
        "cap-0": "# cap-0\n\nNext: /skill:cap-1.\n",
        "cap-1": "# cap-1\n\nNext: /skill:cap-2.\n",
        "cap-2": "# cap-2\n\nNext: /skill:cap-3 and /skill:cap-4.\n",
        "cap-3": "# cap-3\n\nBack to /skill:cap-4.\n",
        "cap-4": "# cap-4\n\nLeaf body.\n",
      };
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
      // The capped ref is not silent: the branch is told it was dropped and
      // where to read it. Reported once, even though the queue can hold the
      // same ref through several referrers.
      assert.strictEqual(
        count(
          delivered,
          `Note: /skill:cap-${MAX_INLINED_ROLE_SKILLS} was not inlined (MAX_INLINED_ROLE_SKILLS=${MAX_INLINED_ROLE_SKILLS} reached); read ${fixtures[MAX_INLINED_ROLE_SKILLS].filePath}.`,
        ),
        1,
        delivered,
      );
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not report a capped ref when the queue empties at the cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-exact-cap-skill-"));
    const h = await TestHarness.create();
    try {
      // A four-link chain: the queue runs dry on the very section that reaches
      // MAX_INLINED_ROLE_SKILLS, so nothing was dropped and no Note belongs in
      // the prompt.
      const bodies: Record<string, string> = {
        "exact-0": "# exact-0\n\nNext: /skill:exact-1.\n",
        "exact-1": "# exact-1\n\nNext: /skill:exact-2.\n",
        "exact-2": "# exact-2\n\nNext: /skill:exact-3.\n",
        "exact-3": "# exact-3\n\nLeaf body.\n",
      };
      assert.strictEqual(Object.keys(bodies).length, MAX_INLINED_ROLE_SKILLS);
      const fixtures = await writeSkills(root, bodies);

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("exact cap roles", "EXACT-CAP-TASK: use /skill:exact-0."),
      );
      h.llm.onPrompt("EXACT-CAP-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.strictEqual(
        count(delivered, "==== Task role skill: "),
        MAX_INLINED_ROLE_SKILLS,
        delivered,
      );
      assert.ok(delivered.includes("==== Task role skill: exact-3 ===="), delivered);
      assert.strictEqual(count(delivered, "was not inlined"), 0, delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports role skills whose SKILL.md cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-unreadable-skill-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nDelegate with /skill:gone-nested.\n";
      const fixtures = await writeSkills(root, { "gone-a": aBody, "gone-nested": "# Gone\n" });
      // Registered, but never written to disk: the top-level ref itself.
      const top = fixtureSkill("gone-top", join(root, "gone-top", "SKILL.md"));
      const nestedPath = fixtures[1].filePath;

      setSkills([...fixtures, top]);
      // The nested skill's file vanishes between push and start.
      await rm(nestedPath);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("unreadable roles", "UNREADABLE-TASK: use /skill:gone-top and /skill:gone-a."),
      );
      h.llm.onPrompt("UNREADABLE-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // The readable skill is still inlined and the run continues; each ref
      // that resolved but could not be read says so, with its path.
      assert.ok(
        delivered.includes(
          `==== Task role skill: gone-a ====\n${aBody.replace("/skill:gone-nested", nestedPath)}`,
        ),
        delivered,
      );
      assert.ok(
        delivered.endsWith(
          `Note: /skill:gone-top could not be read (${top.filePath}).\n` +
            `Note: /skill:gone-nested could not be read (${nestedPath}).`,
        ),
        delivered,
      );
      h.assertSessionContains(assistant("Findings: none."));
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a /skill: mention inside a fenced block as documentation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fenced-skill-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nSyntax reference:\n\n```text\n/skill:fenced-b\n```\n\nFENCED-A-END.\n";
      const bBody = "# B\n\nFENCED-B-BODY.\n";
      const fixtures = await writeSkills(root, { "fenced-a": aBody, "fenced-b": bBody });

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("fenced roles", "FENCED-TASK: apply /skill:fenced-a."),
      );
      h.llm.onPrompt("FENCED-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // The fenced example survives byte-identical, resolves to nothing, and
      // is not reported: it is documentation, not a ref.
      assert.ok(delivered.includes(`==== Task role skill: fenced-a ====\n${aBody}`), delivered);
      assert.ok(!delivered.includes("==== Task role skill: fenced-b ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a closing line with an info string as a fence close", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-close-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\n```text\n/skill:close-doc\n```js\n\nLive ref: /skill:close-live.\n";
      const fixtures = await writeSkills(root, {
        "close-a": aBody,
        "close-doc": "# Fenced doc\n",
        "close-live": "# Live\n",
      });
      const livePath = fixtures[2].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("close with info string", "CLOSE-TASK: apply /skill:close-a."),
      );
      h.llm.onPrompt("CLOSE-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // ```` ```js ```` closes the fence (the info string is ignored), so the
      // mention below it is a live ref and is rewritten — while the fenced span
      // itself (opener, body, closing line) survives byte-identical.
      assert.ok(
        delivered.includes(
          `==== Task role skill: close-a ====\n${aBody.replace("/skill:close-live", livePath)}`,
        ),
        delivered,
      );
      // The mention inside the fence stays documentation: not inlined, not
      // rewritten, not reported as missing.
      assert.ok(!delivered.includes("==== Task role skill: close-doc ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an indented fence opener as a fence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-indent-"));
    const h = await TestHarness.create();
    try {
      // Deliberately not CommonMark: 4 spaces would make this an indented code
      // block, and the stricter indent rule would leave the mention inside it
      // unprotected.
      const aBody =
        "# A\n\nIndented sample:\n\n    ```text\n    /skill:indent-doc\n    ```\n\nINDENT-A-END.\n";
      const fixtures = await writeSkills(root, {
        "indent-a": aBody,
        "indent-doc": "# Indented doc\n",
      });

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("indented fence", "INDENT-TASK: apply /skill:indent-a."),
      );
      h.llm.onPrompt("INDENT-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.ok(delivered.includes(`==== Task role skill: indent-a ====\n${aBody}`), delivered);
      assert.ok(!delivered.includes("==== Task role skill: indent-doc ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves a fenced /skill: mention in the task prompt untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fenced-prompt-"));
    const h = await TestHarness.create();
    try {
      const fixtures = await writeSkills(root, {
        "fence-real": "# Real\n",
        "fence-doc": "# Doc\n",
      });
      const realPath = fixtures[0].filePath;
      const stored = `FENCE-TASK: use /skill:fence-real.\n\n\`\`\`\n/skill:fence-doc\n\`\`\``;

      setSkills(fixtures);
      h.llm.onPrompt("main work", responds("working..."), pushTask("fence prompt", stored));
      h.llm.onPrompt("FENCE-TASK", responds("Findings: none."));

      await h.prompt("main work");
      // The real ref is rewritten at push time; the fenced one is not a ref.
      h.assertSessionContains(
        task("fence prompt", `FENCE-TASK: use ${realPath}.\n\n\`\`\`\n/skill:fence-doc\n\`\`\``),
      );

      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.ok(delivered.includes("```\n/skill:fence-doc\n```"), delivered);
      assert.ok(delivered.includes("==== Task role skill: fence-real ===="), delivered);
      assert.ok(!delivered.includes("==== Task role skill: fence-doc ===="), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a longer closing run as a fence close", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-long-close-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\n```text\n/skill:long-doc\n`````\n\nLive ref: /skill:long-live.\n";
      const fixtures = await writeSkills(root, {
        "long-a": aBody,
        "long-doc": "# Fenced doc\n",
        "long-live": "# Live\n",
      });
      const livePath = fixtures[2].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("longer close", "LONG-TASK: apply /skill:long-a."),
      );
      h.llm.onPrompt("LONG-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // A 5-backtick run closes a 3-backtick opener, so the mention below it
      // is a live ref — while the fenced span (opener, body, closing run)
      // survives byte-identical.
      assert.ok(
        delivered.includes(
          `==== Task role skill: long-a ====\n${aBody.replace("/skill:long-live", livePath)}`,
        ),
        delivered,
      );
      assert.ok(!delivered.includes("==== Task role skill: long-doc ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat a shorter closing run as a fence close", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-short-close-"));
    const h = await TestHarness.create();
    try {
      const aBody =
        "# A\n\n````text\n/skill:short-doc\n```\n/skill:short-doc-2\n````\n\nLive ref: /skill:short-live.\n";
      const fixtures = await writeSkills(root, {
        "short-a": aBody,
        "short-doc": "# Fenced doc\n",
        "short-doc-2": "# Also fenced doc\n",
        "short-live": "# Live\n",
      });
      const livePath = fixtures[3].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("shorter close", "SHORT-TASK: apply /skill:short-a."),
      );
      h.llm.onPrompt("SHORT-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // A 3-backtick line cannot close a 4-backtick opener: it is fenced
      // content, so the mention below it stays documentation too.
      assert.ok(
        delivered.includes(
          `==== Task role skill: short-a ====\n${aBody.replace("/skill:short-live", livePath)}`,
        ),
        delivered,
      );
      assert.ok(!delivered.includes("==== Task role skill: short-doc ===="), delivered);
      assert.ok(!delivered.includes("==== Task role skill: short-doc-2 ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes(fixtures[2].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a tilde fence independently of backticks", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-tilde-"));
    const h = await TestHarness.create();
    try {
      const aBody =
        "# A\n\n~~~text\n/skill:tilde-doc\n```\n/skill:tilde-doc-2\n~~~\n\nLive ref: /skill:tilde-live.\n";
      const fixtures = await writeSkills(root, {
        "tilde-a": aBody,
        "tilde-doc": "# Fenced doc\n",
        "tilde-doc-2": "# Also fenced doc\n",
        "tilde-live": "# Live\n",
      });
      const livePath = fixtures[3].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("tilde fence", "TILDE-TASK: apply /skill:tilde-a."),
      );
      h.llm.onPrompt("TILDE-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // The tilde block runs to its own closer: the backtick line inside it is
      // content, not a close, so neither mention in the block is a ref — and
      // the mention below the block is still rewritten.
      assert.ok(
        delivered.includes(
          `==== Task role skill: tilde-a ====\n${aBody.replace("/skill:tilde-live", livePath)}`,
        ),
        delivered,
      );
      assert.ok(!delivered.includes("==== Task role skill: tilde-doc ===="), delivered);
      assert.ok(!delivered.includes("==== Task role skill: tilde-doc-2 ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes(fixtures[2].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats an unclosed fence as reaching the end of the text", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-fence-eof-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nLive ref: /skill:eof-live.\n\n```text\n/skill:eof-doc\nEOF-A-END.\n";
      const fixtures = await writeSkills(root, {
        "eof-a": aBody,
        "eof-doc": "# Fenced doc\n",
        "eof-live": "# Live\n",
      });
      const livePath = fixtures[2].filePath;

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("unclosed fence", "EOF-TASK: apply /skill:eof-a."),
      );
      h.llm.onPrompt("EOF-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      // Nothing closes the fence, so the mention after the opener stays
      // documentation while the mention above it is a live ref.
      assert.ok(
        delivered.includes(
          `==== Task role skill: eof-a ====\n${aBody.replace("/skill:eof-live", livePath)}`,
        ),
        delivered,
      );
      assert.ok(!delivered.includes("==== Task role skill: eof-doc ===="), delivered);
      assert.ok(!delivered.includes(fixtures[1].filePath), delivered);
      assert.ok(!delivered.includes("\nNote: "), delivered);
    } finally {
      h.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing ref once, naming the first referrer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-tree-missing-ref-"));
    const h = await TestHarness.create();
    try {
      const aBody = "# A\n\nUse /skill:ghost-shared here.\n";
      const bBody = "# B\n\nSee /skill:ghost-shared too.\n";
      const fixtures = await writeSkills(root, { "missing-a": aBody, "missing-b": bBody });

      setSkills(fixtures);
      h.llm.onPrompt(
        "main work",
        responds("working..."),
        pushTask("shared ghost", "GHOST-TASK: apply /skill:missing-a and /skill:missing-b."),
      );
      h.llm.onPrompt("GHOST-TASK", responds("Findings: none."));

      await h.prompt("main work");
      await h.prompt("/start-task");

      const delivered = deliveredPrompt(h);
      assert.ok(delivered.includes(`==== Task role skill: missing-a ====\n${aBody}`), delivered);
      assert.ok(delivered.includes(`==== Task role skill: missing-b ====\n${bBody}`), delivered);
      // Both inlined cards reference the same unknown name: exactly one Note,
      // naming the card that referenced it first.
      assert.strictEqual(count(delivered, "Note: /skill:ghost-shared"), 1, delivered);
      assert.strictEqual(count(delivered, "was not found"), 1, delivered);
      assert.ok(
        delivered.includes("Note: /skill:ghost-shared (referenced by missing-a) was not found."),
        delivered,
      );
      assert.ok(!delivered.includes("referenced by missing-b"), delivered);
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
