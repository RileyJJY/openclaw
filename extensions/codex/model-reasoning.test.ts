import { describe, expect, it } from "vitest";
import {
  isMaxReasoningCodexModel,
  isModernCodexModel,
  readCodexSupportedReasoningEfforts,
  resolveCodexFallbackReasoningEfforts,
  resolveCodexSupportedReasoningEffort,
} from "./model-reasoning.js";

describe("Codex model reasoning policy", () => {
  it.each(["gpt-5.5-pro", "gpt-5.4-pro"])("classifies %s as a modern Codex model", (id) => {
    expect(isModernCodexModel(id)).toBe(true);
  });

  it("keeps native model/list reasoning metadata separate from direct OpenAI metadata", () => {
    expect(
      readCodexSupportedReasoningEfforts({ supportedReasoningEfforts: ["low", "high"] }),
    ).toEqual(["low", "high"]);
    expect(
      readCodexSupportedReasoningEfforts({ supportedReasoningEfforts: ["none", "high"] }),
    ).toBeUndefined();
  });

  it.each([
    ["gpt-5.6-sol", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-terra", ["low", "medium", "high", "xhigh", "max", "ultra"]],
    ["gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5-pro", ["medium", "high", "xhigh"]],
  ] as const)("uses the known %s fallback effort contract", (modelId, expected) => {
    expect(resolveCodexFallbackReasoningEfforts(modelId)).toEqual(expected);
  });

  it.each([
    ["max", ["low", "medium", "high", "xhigh", "ultra"], "xhigh"],
    ["xhigh", ["low", "medium", "high", "ultra"], "high"],
  ] as const)(
    "does not upgrade requested %s to Ultra when model metadata omits that effort",
    (requested, supportedReasoningEfforts, expected) => {
      expect(resolveCodexSupportedReasoningEffort({ requested, supportedReasoningEfforts })).toBe(
        expected,
      );
    },
  );

  it("exposes max only for known native GPT-5.6 models", () => {
    expect(isMaxReasoningCodexModel("gpt-5.6-sol")).toBe(true);
    expect(isMaxReasoningCodexModel("gpt-5.6-terra")).toBe(true);
    expect(isMaxReasoningCodexModel("gpt-5.6-luna")).toBe(true);
    expect(isMaxReasoningCodexModel("gpt-5.6")).toBe(false);
    expect(isMaxReasoningCodexModel("gpt-5.6-sol-oai")).toBe(false);
  });
});
