/** Native Codex app-server reasoning policy used by harness turns. */
const CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

const GPT_56_MAX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const GPT_56_ULTRA_REASONING_EFFORTS = [...GPT_56_MAX_REASONING_EFFORTS, "ultra"] as const;
const GPT_56_ULTRA_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra"]);
const GPT_56_MAX_MODEL_IDS = new Set([...GPT_56_ULTRA_MODEL_IDS, "gpt-5.6-luna"]);
const GPT_5_PRO_REASONING_EFFORTS = ["medium", "high", "xhigh"] as const;

function normalizeCodexReasoningEfforts(
  efforts: readonly string[] | null | undefined,
): CodexReasoningEffort[] {
  if (!efforts) {
    return [];
  }
  const supported = new Set(efforts.map((effort) => effort.trim().toLowerCase()));
  return CODEX_REASONING_EFFORTS.filter((effort) => supported.has(effort));
}

/** Read app-server reasoning metadata from a runtime model compat union. */
export function readCodexSupportedReasoningEfforts(compat: unknown): string[] | undefined {
  if (!compat || typeof compat !== "object" || Array.isArray(compat)) {
    return undefined;
  }
  const efforts = (compat as { supportedReasoningEfforts?: unknown }).supportedReasoningEfforts;
  if (!Array.isArray(efforts)) {
    return undefined;
  }
  const strings = efforts.filter((effort): effort is string => typeof effort === "string");
  // Direct OpenAI Responses metadata advertises `none`; Codex model/list does
  // not. Do not let the direct API contract override native Codex capabilities.
  return strings.some((effort) => effort.trim().toLowerCase() === "none") ? undefined : strings;
}

/** Map a requested effort onto the authoritative app-server model contract. */
export function resolveCodexSupportedReasoningEffort(params: {
  requested: CodexReasoningEffort;
  supportedReasoningEfforts: readonly string[];
}): CodexReasoningEffort | undefined {
  const supported = normalizeCodexReasoningEfforts(params.supportedReasoningEfforts);
  if (supported.includes(params.requested)) {
    return params.requested;
  }
  // Ultra enables proactive multi-agent behavior, so it must be explicit.
  // Lower-effort fallback may select Max or below, never Ultra.
  const fallbackEfforts =
    params.requested === "ultra" ? supported : supported.filter((effort) => effort !== "ultra");
  const requestedRank = CODEX_REASONING_EFFORTS.indexOf(params.requested);
  return (
    fallbackEfforts.find((effort) => CODEX_REASONING_EFFORTS.indexOf(effort) >= requestedRank) ??
    fallbackEfforts.at(-1)
  );
}

/** Return the known effort contract when app-server model metadata is unavailable. */
export function resolveCodexFallbackReasoningEfforts(
  modelId: string,
): readonly CodexReasoningEffort[] | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (GPT_56_ULTRA_MODEL_IDS.has(normalized)) {
    return GPT_56_ULTRA_REASONING_EFFORTS;
  }
  if (normalized === "gpt-5.6-luna") {
    return GPT_56_MAX_REASONING_EFFORTS;
  }
  if (normalized === "gpt-5.5-pro" || normalized === "gpt-5.4-pro") {
    return GPT_5_PRO_REASONING_EFFORTS;
  }
  return undefined;
}

/** Return whether the model uses the modern Codex reasoning profile. */
export function isModernCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return (
    GPT_56_MAX_MODEL_IDS.has(lower) ||
    lower === "gpt-5.5" ||
    lower === "gpt-5.5-pro" ||
    lower === "gpt-5.4" ||
    lower === "gpt-5.4-pro" ||
    lower === "gpt-5.4-mini" ||
    lower === "gpt-5.3-codex-spark"
  );
}

/** Return whether Codex accepts the preview GPT-5.6 `max` reasoning effort. */
export function isMaxReasoningCodexModel(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase();
  return GPT_56_MAX_MODEL_IDS.has(lower);
}
