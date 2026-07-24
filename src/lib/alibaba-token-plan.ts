import { randomUUID } from "crypto";
import { fetchWithTimeout } from "./http.js";
import { sanitizeDisplayText } from "./display-sanitize.js";

const API_BASE_URL = "https://bailian-singapore-cs.alibabacloud.com/data/api.json";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0";
const SCRAPE_TIMEOUT_MS = 10_000;

export interface AlibabaTokenPlanWindow {
  usagePercent: number;
  percentRemaining: number;
  resetTimeIso: string;
}

export type AlibabaTokenPlanResult =
  | {
      success: true;
      fiveHour?: AlibabaTokenPlanWindow;
      weekly?: AlibabaTokenPlanWindow;
    }
  | { success: false; error: string }
  | null;

interface UsageApiResponse {
  code?: string;
  data?: {
    DataV2?: {
      data?: {
        data?: {
          per5HourPercentage?: number;
          per1WeekPercentage?: number;
          per5HourResetTime?: number;
          per1WeekResetTime?: number;
        };
        success?: boolean;
      };
    };
    success?: boolean;
  };
  successResponse?: boolean;
}

function sanitizeMessage(text: string, maxLength = 120): string {
  const sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return (sanitized || "unknown").slice(0, maxLength);
}

function buildRequestBody(region: string): string {
  const params = JSON.stringify({
    Api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
    V: "1.0",
    Data: {
      cornerstoneParam: {
        feTraceId: randomUUID(),
        feURL:
          "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan#/efm/subscription/token-plan/personal",
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchAgent: 214253,
        switchUserType: 3,
        domain: "modelstudio.console.alibabacloud.com",
        consoleSite: "MODELSTUDIO_ALBABACLOUD",
        userNickName: "",
        userPrincipalName: "",
        xsp_lang: "en-US",
      },
    },
  });

  return new URLSearchParams({
    params,
    region,
  }).toString();
}

export async function queryAlibabaTokenPlanQuota(
  authCookie: string,
  secToken: string,
  options: { requestTimeoutMs?: number; region?: string } = {},
): Promise<AlibabaTokenPlanResult> {
  try {
    const region = options.region || "ap-southeast-1";
    const url = `${API_BASE_URL}?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`;

    const body = buildRequestBody(region) + `&sec_token=${encodeURIComponent(secToken)}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://modelstudio.console.alibabacloud.com",
          Referer: "https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=plan",
          Cookie: authCookie,
        },
        body,
      },
      options.requestTimeoutMs ?? SCRAPE_TIMEOUT_MS,
    );

    if (!response.ok) {
      const text = await response.text();
      return {
        success: false,
        error: `Alibaba Token Plan API error ${response.status}: ${sanitizeMessage(text)}`,
      };
    }

    const json = (await response.json()) as UsageApiResponse;

    if (!json.successResponse || json.code !== "200") {
      return {
        success: false,
        error: `Alibaba Token Plan API returned error code: ${json.code ?? "unknown"}`,
      };
    }

    const innerData = json.data?.DataV2?.data;
    if (!innerData?.success || !innerData.data) {
      return {
        success: false,
        error: "Alibaba Token Plan API returned unsuccessful inner response",
      };
    }

    const usage = innerData.data;
    const result: Extract<AlibabaTokenPlanResult, { success: true }> = { success: true };

    if (
      typeof usage.per5HourPercentage === "number" &&
      typeof usage.per5HourResetTime === "number"
    ) {
      const usagePercent = usage.per5HourPercentage * 100;
      result.fiveHour = {
        usagePercent,
        percentRemaining: Math.max(0, 100 - usagePercent),
        resetTimeIso: new Date(usage.per5HourResetTime).toISOString(),
      };
    }

    if (
      typeof usage.per1WeekPercentage === "number" &&
      typeof usage.per1WeekResetTime === "number"
    ) {
      const usagePercent = usage.per1WeekPercentage * 100;
      result.weekly = {
        usagePercent,
        percentRemaining: Math.max(0, 100 - usagePercent),
        resetTimeIso: new Date(usage.per1WeekResetTime).toISOString(),
      };
    }

    if (!result.fiveHour && !result.weekly) {
      return {
        success: false,
        error: "Alibaba Token Plan API returned no usage windows",
      };
    }

    return result;
  } catch (err) {
    return {
      success: false,
      error: sanitizeMessage(err instanceof Error ? err.message : String(err)),
    };
  }
}
