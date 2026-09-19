/**
 * Host-path safety for the Lingbang control plane (plan §7.1, §11.5).
 *
 * Every path that reaches the Workspace registry, or that backs a document
 * reference, passes through here first. The rules are deliberately closed by
 * default: an empty `allowedRoots` means "no path addressing at all", so a
 * misconfigured plugin can never hand an external caller the whole filesystem.
 *
 * @module @void/void-dsh-control/workspace
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { ControlError } from "./protocol.js";

/** Path policy derived from plugin configuration. */
export interface PathGuard {
  /** Real paths a caller may address. Empty disables all path addressing. */
  readonly allowedRoots: readonly string[];
}

/**
 * Normalize a host path for comparison: resolve `.`/`..` textually, drop a
 * trailing separator and lowercase on Windows, whose filesystem is
 * case-insensitive.
 *
 * @param path - Absolute host path.
 * @returns The comparison key.
 */
export function comparisonKey(path: string): string {
  const normalized = normalize(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Whether a real path is the root itself or lives under it.
 *
 * Uses path-segment comparison rather than a string prefix so `/srv/app-other`
 * is not accepted by a `/srv/app` root.
 *
 * @param candidate - Real path to test.
 * @param root - Allowed root, already real.
 * @returns True when the candidate is contained by the root.
 */
export function isInside(candidate: string, root: string): boolean {
  const rel = relative(comparisonKey(root), comparisonKey(candidate));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Resolve an allowed-root list to real paths.
 *
 * Roots that do not exist are dropped rather than failing activation: a
 * configured root on a detached drive should reduce the plugin's reach, not
 * prevent it from starting. Dropping is logged by the caller.
 *
 * @param roots - Configured root paths.
 * @returns Real, existing, de-duplicated roots.
 */
export async function resolveAllowedRoots(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    let real: string;
    try {
      real = await realpath(root);
    } catch {
      continue;
    }
    const info = await stat(real).catch(() => undefined);
    if (info?.isDirectory() !== true) continue;
    const key = comparisonKey(real);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

/**
 * Validate a caller-supplied absolute directory against the guard.
 *
 * Steps, in order (plan §7.1): reject a relative path, `realpath` it, require an
 * existing directory, require a non-empty `allowedRoots`, and require containment
 * after `realpath` so a symlink cannot escape an allowed root.
 *
 * @param rawPath - Caller-supplied path.
 * @param guard - Configured path policy.
 * @returns The canonical real path.
 * @throws ControlError `dsh-control/workspace-path-invalid` or `dsh-control/workspace-not-allowed`.
 */
export async function assertAllowedDirectory(rawPath: string, guard: PathGuard): Promise<string> {
  if (!isAbsolute(rawPath)) {
    throw new ControlError("dsh-control/workspace-path-invalid", "workspace path must be absolute", { path: rawPath });
  }

  let real: string;
  try {
    real = await realpath(rawPath);
  } catch {
    // The underlying errno is deliberately dropped: it would disclose whether an
    // out-of-policy path exists on the host.
    throw new ControlError("dsh-control/workspace-path-invalid", "workspace path does not exist or is not readable", {
      path: rawPath,
    });
  }

  const info = await stat(real).catch(() => undefined);
  if (info?.isDirectory() !== true) {
    throw new ControlError("dsh-control/workspace-path-invalid", "workspace path must be an existing directory", {
      path: rawPath,
    });
  }

  if (guard.allowedRoots.length === 0) {
    throw new ControlError(
      "dsh-control/workspace-not-allowed",
      "path-based workspace addressing is disabled: configure allowedRoots to enable it",
      { path: rawPath },
    );
  }

  if (!guard.allowedRoots.some((root) => isInside(real, root))) {
    throw new ControlError("dsh-control/workspace-not-allowed", "workspace path is outside every allowed root", {
      path: rawPath,
    });
  }

  return real;
}

/**
 * Whether a path textually contains a parent-directory segment.
 *
 * @param path - Path as the caller wrote it.
 * @returns True when any segment is exactly `..`.
 */
export function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]+/).includes("..");
}

/**
 * Validate a caller-supplied path that must live inside a workspace.
 *
 * The two addressing modes have deliberately different reach (plan §8.2):
 *
 * - a **relative** path is resolved against `workspaceRoot` and must stay inside
 *   it; `..` segments are refused outright, so `../sibling/file` can never be
 *   used to walk into another allowed root;
 * - an **absolute** path may additionally live in any configured `allowedRoots`,
 *   because writing an absolute path is an explicit statement about which root
 *   the caller means.
 *
 * `realpath` containment is the actual boundary, so symlink escape fails the
 * same way regardless of how the path was written.
 *
 * @param rawPath - Caller-supplied path, relative or absolute.
 * @param workspaceRoot - Real path of the workspace the reference belongs to.
 * @param guard - Configured path policy.
 * @returns The canonical real path.
 * @throws ControlError `dsh-control/workspace-path-invalid` or `dsh-control/workspace-not-allowed`.
 */
export async function assertPathInsideWorkspace(
  rawPath: string,
  workspaceRoot: string,
  guard: PathGuard,
): Promise<string> {
  const absolute = isAbsolute(rawPath);

  if (!absolute && hasParentSegment(rawPath)) {
    throw new ControlError(
      "dsh-control/workspace-not-allowed",
      "a relative reference must not traverse outside the workspace; use an absolute path to address another allowed root",
      { path: rawPath },
    );
  }

  const candidate = absolute ? rawPath : resolve(workspaceRoot, rawPath);

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new ControlError("dsh-control/workspace-path-invalid", "referenced path does not exist", {
      path: rawPath,
    });
  }

  if (isInside(real, workspaceRoot)) return real;
  if (absolute && guard.allowedRoots.some((root) => isInside(real, root))) return real;

  throw new ControlError("dsh-control/workspace-not-allowed", "referenced path escapes the workspace", {
    path: rawPath,
  });
}

/**
 * Render a workspace-relative path for a message the DSH agent will read.
 *
 * @param realPath - Canonical real path inside the workspace.
 * @param workspaceRoot - Canonical workspace root.
 * @returns A forward-slash relative path, or `.` for the root itself.
 */
export function toWorkspaceRelative(realPath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, realPath);
  if (rel === "") return ".";
  return rel.split(sep).join("/");
}
