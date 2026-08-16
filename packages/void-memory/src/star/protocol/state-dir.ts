import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const STATE_DIR_ENV_KEY = "BELLDANDY_STATE_DIR";
export const STATE_DIR_WINDOWS_ENV_KEY = "BELLDANDY_STATE_DIR_WINDOWS";
export const STATE_DIR_WSL_ENV_KEY = "BELLDANDY_STATE_DIR_WSL";
export const LEGACY_STATE_DIR_BASENAME = ".belldandy";
export const DEFAULT_STATE_DIR_BASENAME = ".star_sanctuary";
export const LEGACY_STATE_DIR_DISPLAY = `~/${LEGACY_STATE_DIR_BASENAME}`;
export const DEFAULT_STATE_DIR_DISPLAY = `~/${DEFAULT_STATE_DIR_BASENAME}`;

export type PathExists = (filePath: string) => boolean;

function defaultExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export function resolveNamedCompatDir(params: {
  rootDir: string;
  preferredBaseName: string;
  legacyBaseName: string;
  exists?: PathExists;
}): string {
  const exists = params.exists ?? defaultExists;
  const preferredDir = path.join(params.rootDir, params.preferredBaseName);
  if (exists(preferredDir)) return preferredDir;

  const legacyDir = path.join(params.rootDir, params.legacyBaseName);
  if (exists(legacyDir)) return legacyDir;

  return preferredDir;
}

export function resolveDefaultStateDir(params?: {
  homeDir?: string;
  exists?: PathExists;
}): string {
  return resolveNamedCompatDir({
    rootDir: params?.homeDir ?? os.homedir(),
    preferredBaseName: DEFAULT_STATE_DIR_BASENAME,
    legacyBaseName: LEGACY_STATE_DIR_BASENAME,
    exists: params?.exists,
  });
}

function normalizeExplicitStateDir(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function isWslRuntime(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  return platform === "linux" && !!(env.WSL_DISTRO_NAME?.trim() || env.WSL_INTEROP?.trim());
}

export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  params?: { homeDir?: string; exists?: PathExists; platform?: NodeJS.Platform },
): string {
  const homeDir = params?.homeDir ?? os.homedir();
  const platform = params?.platform ?? process.platform;

  if (platform === "win32") {
    const explicitWindows = env[STATE_DIR_WINDOWS_ENV_KEY]?.trim();
    if (explicitWindows) return normalizeExplicitStateDir(explicitWindows, homeDir);
  }

  if (isWslRuntime(env, platform)) {
    const explicitWsl = env[STATE_DIR_WSL_ENV_KEY]?.trim();
    if (explicitWsl) return normalizeExplicitStateDir(explicitWsl, homeDir);
  }

  const explicit = env[STATE_DIR_ENV_KEY]?.trim();
  if (explicit) return normalizeExplicitStateDir(explicit, homeDir);
  return resolveDefaultStateDir({ homeDir, exists: params?.exists });
}

export function resolveWorkspaceStateDir(
  workspaceRoot: string,
  exists?: PathExists,
): string {
  return resolveNamedCompatDir({
    rootDir: workspaceRoot,
    preferredBaseName: DEFAULT_STATE_DIR_BASENAME,
    legacyBaseName: LEGACY_STATE_DIR_BASENAME,
    exists,
  });
}
