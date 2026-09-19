import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAllowedDirectory, assertPathInsideWorkspace, isInside, resolveAllowedRoots, toWorkspaceRelative } from "../src/workspace.js";
import { isSensitivePath, renderDocumentRefs, resolveDocumentRefs } from "../src/document-refs.js";
import { ControlError, LIMITS } from "../src/protocol.js";

let root = "";
let outside = "";

beforeAll(async () => {
  const base = await mkdtemp(join(tmpdir(), "void-dsh-control-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "docs", "task.md"), "# Task\n\nDo the thing.\n", "utf8");
  await writeFile(join(root, ".env"), "SECRET=1\n", "utf8");
  await writeFile(join(root, "big.md"), "x".repeat(LIMITS.maxInlineDocumentBytes + 10), "utf8");
  await writeFile(join(outside, "secret.md"), "nope\n", "utf8");
});

afterAll(async () => {
  await rm(resolve(root, ".."), { recursive: true, force: true });
});

describe("workspace: containment", () => {
  it("matches a root and its descendants only", () => {
    expect(isInside("/srv/app", "/srv/app")).toBe(true);
    expect(isInside("/srv/app/sub", "/srv/app")).toBe(true);
    expect(isInside("/srv/app-other", "/srv/app")).toBe(false);
    expect(isInside("/srv", "/srv/app")).toBe(false);
  });

  it("drops configured roots that are not existing absolute directories", async () => {
    const roots = await resolveAllowedRoots([root, join(root, "missing"), "relative/path"]);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.toLowerCase()).toBe((await import("node:fs/promises").then((fs) => fs.realpath(root))).toLowerCase());
  });
});

describe("workspace: path addressing", () => {
  it("rejects a relative path", async () => {
    await expect(assertAllowedDirectory("docs", { allowedRoots: [root] })).rejects.toThrowError(/must be absolute/);
  });

  it("rejects a missing path without disclosing the errno", async () => {
    const error = await assertAllowedDirectory(join(root, "nope"), { allowedRoots: [root] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe("dsh-control/workspace-path-invalid");
    expect((error as ControlError).message).not.toMatch(/ENOENT|errno/i);
  });

  it("refuses path addressing entirely when no root is configured", async () => {
    const error = await assertAllowedDirectory(root, { allowedRoots: [] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
    expect((error as ControlError).message).toMatch(/allowedRoots/);
  });

  it("accepts a directory inside an allowed root", async () => {
    await expect(assertAllowedDirectory(join(root, "docs"), { allowedRoots: [root] })).resolves.toBeTruthy();
  });

  it("refuses a directory outside every allowed root", async () => {
    const error = await assertAllowedDirectory(outside, { allowedRoots: [root] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("refuses a file where a directory is required", async () => {
    const error = await assertAllowedDirectory(join(root, "docs", "task.md"), { allowedRoots: [root] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-path-invalid");
  });

  it("blocks symlink escape through realpath containment", async () => {
    const link = join(root, "escape");
    try {
      await symlink(outside, link, "junction");
    } catch {
      return; // Symlink creation needs privileges on Windows; skip when unavailable.
    }
    const error = await assertPathInsideWorkspace("escape/secret.md", root, { allowedRoots: [] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("blocks .. traversal", async () => {
    const error = await assertPathInsideWorkspace("../outside/secret.md", root, { allowedRoots: [] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("blocks .. traversal even when the target is another allowed root", async () => {
    // §26.1-2: resolving first and checking containment afterwards let a
    // relative `../...` reference reach a second allowed root and be handed to
    // the agent verbatim. A relative reference must stay in its workspace.
    await writeFile(join(outside, "shared.md"), "# Shared\n", "utf8");
    const guard = { allowedRoots: [resolve(root), resolve(outside)] };

    const relative = await assertPathInsideWorkspace("../outside/shared.md", root, guard).catch((caught: unknown) => caught);
    expect((relative as ControlError).code).toBe("dsh-control/workspace-not-allowed");
    expect((relative as ControlError).message).toMatch(/must not traverse/);

    // The same file is reachable when the caller says which root it means.
    await expect(assertPathInsideWorkspace(join(outside, "shared.md"), root, guard)).resolves.toBe(resolve(outside, "shared.md"));
  });

  it("blocks an inner .. segment that would land in another allowed root", async () => {
    await writeFile(join(outside, "inner.md"), "# Inner\n", "utf8");
    const guard = { allowedRoots: [resolve(root), resolve(outside)] };
    const error = await assertPathInsideWorkspace(`docs/../../outside/inner.md`, root, guard).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("still allows a .. segment that stays inside the workspace", async () => {
    // Refusing the segment outright is deliberate: the rule is about how the
    // path is written, so it cannot depend on where the target happens to land.
    const error = await assertPathInsideWorkspace("docs/../docs/task.md", root, { allowedRoots: [] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
    await expect(assertPathInsideWorkspace("docs/task.md", root, { allowedRoots: [] })).resolves.toBe(join(root, "docs", "task.md"));
  });

  it("blocks a relative reference that resolves outside every root", async () => {
    await writeFile(join(outside, "lonely.md"), "# Lonely\n", "utf8");
    const error = await assertPathInsideWorkspace("../outside/lonely.md", root, { allowedRoots: [] }).catch((caught: unknown) => caught);
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });

  it("refuses an inline .. reference through the document-ref resolver", async () => {
    await writeFile(join(outside, "secret.md"), "# Outside\n", "utf8");
    const guard = { allowedRoots: [resolve(root), resolve(outside)] };
    const error = await resolveDocumentRefs([{ path: "../outside/secret.md", mode: "inline" }], root, guard).catch(
      (caught: unknown) => caught,
    );
    expect((error as ControlError).code).toBe("dsh-control/workspace-not-allowed");
  });
});

describe("document refs: sensitive files", () => {
  it("flags credentials-shaped names", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("config/.credentials.yaml")).toBe(true);
    expect(isSensitivePath("keys/server.pem")).toBe(true);
    expect(isSensitivePath("docs/task.md")).toBe(false);
  });

  it("refuses to inline a sensitive file", async () => {
    const error = await resolveDocumentRefs([{ path: ".env", mode: "inline" }], root, { allowedRoots: [] }).catch(
      (caught: unknown) => caught,
    );
    expect((error as ControlError).code).toBe("dsh-control/policy-document-invalid");
    expect((error as ControlError).message).toMatch(/credentials/);
  });

  it("still allows a sensitive file to be referenced by path", async () => {
    const refs = await resolveDocumentRefs([{ path: ".env", mode: "reference" }], root, { allowedRoots: [] });
    expect(refs).toEqual([{ relativePath: ".env", mode: "reference" }]);
  });
});

describe("document refs: resolution", () => {
  it("resolves a relative path to a workspace-relative name", async () => {
    const refs = await resolveDocumentRefs([{ path: "docs/task.md", mode: "inline" }], root, { allowedRoots: [] });
    expect(refs[0]!.relativePath).toBe("docs/task.md");
    expect(refs[0]!.text).toContain("Do the thing");
    expect(refs[0]!.truncated).toBe(false);
  });

  it("refuses a directory reference", async () => {
    const error = await resolveDocumentRefs([{ path: "docs", mode: "inline" }], root, { allowedRoots: [] }).catch(
      (caught: unknown) => caught,
    );
    expect((error as ControlError).code).toBe("dsh-control/policy-document-invalid");
  });

  it("refuses an inline document over the per-file bound", async () => {
    const error = await resolveDocumentRefs([{ path: "big.md", mode: "inline" }], root, { allowedRoots: [] }).catch(
      (caught: unknown) => caught,
    );
    expect((error as ControlError).code).toBe("dsh-control/limit-exceeded");
  });

  it("resolves all-or-nothing", async () => {
    await expect(
      resolveDocumentRefs(
        [
          { path: "docs/task.md", mode: "reference" },
          { path: "../outside/secret.md", mode: "reference" },
        ],
        root,
        { allowedRoots: [] },
      ),
    ).rejects.toThrowError(ControlError);
  });

  it("renders references and inlines with provenance markers", async () => {
    const refs = await resolveDocumentRefs(
      [
        { path: "docs/task.md", mode: "reference" },
        { path: "docs/task.md", mode: "inline" },
      ],
      root,
      { allowedRoots: [] },
    );
    const rendered = renderDocumentRefs(refs);
    expect(rendered).toContain("文档引用：`docs/task.md`");
    expect(rendered).toContain("文档内联：`docs/task.md`");
    expect(renderDocumentRefs([])).toBe("");
  });
});

describe("workspace: relative rendering", () => {
  it("normalizes separators", () => {
    expect(toWorkspaceRelative(join(root, "docs", "task.md"), root)).toBe("docs/task.md");
    expect(toWorkspaceRelative(root, root)).toBe(".");
  });
});
