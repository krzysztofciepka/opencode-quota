import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  computeAlibabaCodingPlanQuota,
  readAlibabaCodingPlanQuotaState,
} from "../lib/qwen-local-quota.js";
import {
  DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
  isAlibabaModelId,
  resolveAlibabaCodingPlanAuthCached,
} from "../lib/alibaba-auth.js";
import {
  DEFAULT_ALIBABA_TOKEN_PLAN_CONFIG_CACHE_MAX_AGE_MS,
  resolveAlibabaTokenPlanConfigCached,
} from "../lib/alibaba-token-plan-config.js";
import { queryAlibabaTokenPlanQuota } from "../lib/alibaba-token-plan.js";
import { attemptedErrorResult, attemptedResult, notAttemptedResult } from "./result-helpers.js";
import { findQuotaProviderDefinition } from "../lib/quota-providers.js";

const PROVIDER_LABEL = "Alibaba Token Plan";

function tierLabel(tier: "lite" | "pro"): string {
  return tier === "pro" ? "Pro" : "Lite";
}

async function fetchRemote(ctx: QuotaProviderContext): Promise<QuotaProviderResult | null> {
  const config = await resolveAlibabaTokenPlanConfigCached({
    maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_CONFIG_CACHE_MAX_AGE_MS,
  });

  if (config.state !== "configured") {
    return null;
  }

  const result = await queryAlibabaTokenPlanQuota(config.config.authCookie, config.config.secToken, {
    requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
      ? ctx.config.requestTimeoutMs
      : undefined,
    region: config.config.region,
  });

  if (!result) {
    return null;
  }

  if (!result.success) {
    return attemptedErrorResult(PROVIDER_LABEL, result.error);
  }

  const entries: QuotaToastEntry[] = [];

  if (result.fiveHour) {
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: `${PROVIDER_LABEL} 5h`,
      group: PROVIDER_LABEL,
      label: "5h:",
      percentRemaining: result.fiveHour.percentRemaining,
      resetTimeIso: result.fiveHour.resetTimeIso,
    });
  }

  if (result.weekly) {
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: `${PROVIDER_LABEL} Weekly`,
      group: PROVIDER_LABEL,
      label: "Weekly:",
      percentRemaining: result.weekly.percentRemaining,
      resetTimeIso: result.weekly.resetTimeIso,
    });
  }

  return attemptedResult(entries);
}

async function fetchLocalEstimate(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
  const plan = await resolveAlibabaCodingPlanAuthCached({
    maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
    fallbackTier: "lite",
  });
  if (plan.state === "none") {
    return notAttemptedResult();
  }

  if (plan.state === "invalid") {
    return attemptedErrorResult("Alibaba Coding Plan", plan.error);
  }

  const tuning = findQuotaProviderDefinition(
    ctx.config.quotaProviders ?? [],
    "alibaba-coding-plan",
  );
  const limits =
    tuning?.mode === "local-estimate"
      ? {
          fiveHour: tuning.windows.find((window) => window.id === "five-hour")!.requestLimit,
          weekly: tuning.windows.find((window) => window.id === "weekly")!.requestLimit,
          monthly: tuning.windows.find((window) => window.id === "monthly")!.requestLimit,
        }
      : undefined;
  const quota = computeAlibabaCodingPlanQuota({
    state: await readAlibabaCodingPlanQuotaState(),
    tier: plan.tier,
    ...(limits ? { limits } : {}),
  });
  const label = `Alibaba Coding Plan (${tierLabel(plan.tier)})`;

  const entries: QuotaToastEntry[] = [
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "local_estimation",
        ownership: "maintained",
        authority: "locally_derived",
      },
      name: `${label} 5h`,
      group: label,
      label: "5h:",
      right: `${quota.fiveHour.used}/${quota.fiveHour.limit}`,
      percentRemaining: quota.fiveHour.percentRemaining,
      resetTimeIso: quota.fiveHour.resetTimeIso,
    },
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "local_estimation",
        ownership: "maintained",
        authority: "locally_derived",
      },
      name: `${label} Weekly`,
      group: label,
      label: "Weekly:",
      right: `${quota.weekly.used}/${quota.weekly.limit}`,
      percentRemaining: quota.weekly.percentRemaining,
      resetTimeIso: quota.weekly.resetTimeIso,
    },
    {
      accounting: {
        resultType: "quota",
        acquisitionMethod: "local_estimation",
        ownership: "maintained",
        authority: "locally_derived",
      },
      name: `${label} Monthly`,
      group: label,
      label: "Monthly:",
      right: `${quota.monthly.used}/${quota.monthly.limit}`,
      percentRemaining: quota.monthly.percentRemaining,
      resetTimeIso: quota.monthly.resetTimeIso,
    },
  ];

  return attemptedResult(entries);
}

export const alibabaCodingPlanProvider: QuotaProvider = {
  id: "alibaba-coding-plan",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const remoteConfig = await resolveAlibabaTokenPlanConfigCached({
      maxAgeMs: DEFAULT_ALIBABA_TOKEN_PLAN_CONFIG_CACHE_MAX_AGE_MS,
    });
    if (remoteConfig.state === "configured") {
      return true;
    }

    const plan = await resolveAlibabaCodingPlanAuthCached({
      maxAgeMs: DEFAULT_ALIBABA_AUTH_CACHE_MAX_AGE_MS,
      fallbackTier: "lite",
    });
    return plan.state === "configured" || plan.state === "invalid";
  },

  matchesCurrentModel(model: string, context): boolean {
    return context?.currentProviderID
      ? context.currentProviderID === "alibaba-coding-plan" ||
          context.currentProviderID === "alibaba"
      : isAlibabaModelId(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const remote = await fetchRemote(ctx);
    if (remote) {
      return remote;
    }
    return fetchLocalEstimate(ctx);
  },
};
