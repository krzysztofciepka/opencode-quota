import { readFile } from "fs/promises";
import { join } from "path";

import { getOpencodeRuntimeDirCandidates } from "./opencode-runtime-paths.js";

export interface AlibabaTokenPlanConfig {
  authCookie: string;
  secToken: string;
  region?: string;
}

export type ResolvedAlibabaTokenPlanConfig =
  | { state: "none" }
  | { state: "configured"; config: AlibabaTokenPlanConfig; source: string }
  | { state: "incomplete"; source: string; missing: string }
  | { state: "invalid"; source: string; error: string };

export interface AlibabaTokenPlanConfigDiagnostics {
  state: ResolvedAlibabaTokenPlanConfig["state"];
  source: string | null;
  missing: string | null;
  error: string | null;
  checkedPaths: string[];
}

type ReadConfigFileResult =
  | { state: "missing" }
  | { state: "loaded"; config: Partial<AlibabaTokenPlanConfig> }
  | { state: "invalid"; error: string };

function getConfigCandidatePaths(): string[] {
  const { configDirs } = getOpencodeRuntimeDirCandidates();
  return configDirs.map((dir) => join(dir, "opencode-quota", "alibaba-token-plan.json"));
}

function getConfigFileError(error: unknown): string {
  if (error instanceof SyntaxError) {
    return `Failed to parse JSON: ${error.message}`;
  }
  if (error instanceof Error && error.message) {
    return `Failed to read config file: ${error.message}`;
  }
  return `Failed to read config file: ${String(error)}`;
}

async function readConfigFile(path: string): Promise<ReadConfigFileResult> {
  try {
    const data = await readFile(path, "utf-8");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: "invalid", error: "Config file must contain a JSON object" };
    }
    return { state: "loaded", config: parsed as Partial<AlibabaTokenPlanConfig> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: getConfigFileError(error) };
  }
}

export function resolveAlibabaTokenPlanConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAlibabaTokenPlanConfig | null {
  const authCookie = env.ALIBABA_TOKEN_PLAN_AUTH_COOKIE?.trim();
  const secToken = env.ALIBABA_TOKEN_PLAN_SEC_TOKEN?.trim();

  if (!authCookie && !secToken) return null;

  if (authCookie && secToken) {
    return {
      state: "configured",
      config: { authCookie, secToken, region: env.ALIBABA_TOKEN_PLAN_REGION?.trim() || undefined },
      source: "env",
    };
  }

  return {
    state: "incomplete",
    source: "env",
    missing: authCookie ? "ALIBABA_TOKEN_PLAN_SEC_TOKEN" : "ALIBABA_TOKEN_PLAN_AUTH_COOKIE",
  };
}

export async function resolveAlibabaTokenPlanConfig(): Promise<ResolvedAlibabaTokenPlanConfig> {
  const envResult = resolveAlibabaTokenPlanConfigFromEnv();
  if (envResult) return envResult;

  const candidates = getConfigCandidatePaths();
  for (const path of candidates) {
    const fileResult = await readConfigFile(path);
    if (fileResult.state === "missing") continue;
    if (fileResult.state === "invalid") {
      return { state: "invalid", source: path, error: fileResult.error };
    }

    const config = fileResult.config;

    const authCookie = typeof config.authCookie === "string" ? config.authCookie.trim() : "";
    const secToken = typeof config.secToken === "string" ? config.secToken.trim() : "";
    const region = typeof config.region === "string" ? config.region.trim() : undefined;

    if (authCookie && secToken) {
      return {
        state: "configured",
        config: { authCookie, secToken, region: region || undefined },
        source: path,
      };
    }

    const missing = !authCookie ? "authCookie" : "secToken";
    return { state: "incomplete", source: path, missing };
  }

  return { state: "none" };
}

let cachedConfig: ResolvedAlibabaTokenPlanConfig | null = null;
let cachedAt = 0;

const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export { DEFAULT_CACHE_MAX_AGE_MS as DEFAULT_ALIBABA_TOKEN_PLAN_CONFIG_CACHE_MAX_AGE_MS };

export async function resolveAlibabaTokenPlanConfigCached(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedAlibabaTokenPlanConfig> {
  const maxAgeMs = Math.max(0, params?.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = Date.now();
  if (cachedConfig && now - cachedAt < maxAgeMs) {
    return cachedConfig;
  }
  cachedConfig = await resolveAlibabaTokenPlanConfig();
  cachedAt = now;
  return cachedConfig;
}

export async function getAlibabaTokenPlanConfigDiagnostics(): Promise<AlibabaTokenPlanConfigDiagnostics> {
  const resolved = await resolveAlibabaTokenPlanConfig();
  const checkedPaths = getConfigCandidatePaths();

  if (resolved.state === "none") {
    return { state: "none", source: null, missing: null, error: null, checkedPaths };
  }

  if (resolved.state === "incomplete") {
    return {
      state: "incomplete",
      source: resolved.source,
      missing: resolved.missing,
      error: null,
      checkedPaths,
    };
  }

  if (resolved.state === "invalid") {
    return {
      state: "invalid",
      source: resolved.source,
      missing: null,
      error: resolved.error,
      checkedPaths,
    };
  }

  return {
    state: "configured",
    source: resolved.source,
    missing: null,
    error: null,
    checkedPaths,
  };
}
