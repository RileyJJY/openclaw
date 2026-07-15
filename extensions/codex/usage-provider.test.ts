import * as authMarkers from "openclaw/plugin-sdk/agent-runtime";
import { describe, expect, it, vi } from "vitest";
import { buildCodexUsageProvider } from "./usage-provider.js";

function usageAuth(token: string): { token: string } {
  return { token };
}

describe("buildCodexUsageProvider", () => {
  it("exposes no model catalog or auth route", () => {
    const provider = buildCodexUsageProvider();

    expect(provider).toMatchObject({ id: "codex", auth: [] });
    expect(provider).not.toHaveProperty("catalog");
    expect(provider).not.toHaveProperty("staticCatalog");
    expect(provider).not.toHaveProperty("resolveDynamicModel");
    expect(provider).not.toHaveProperty("resolveSyntheticAuth");
  });

  it("fetches app-server usage only for the synthetic Codex marker", async () => {
    const readUsage = vi.fn(async () => ({
      rateLimits: {
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: {
              usedPercent: 9,
              windowDurationMins: 300,
              resetsAt: 1_700_003_600,
            },
          },
        },
      },
      accountEmail: "codex-account@example.com",
    }));
    const provider = buildCodexUsageProvider({ readUsage });

    await expect(
      provider.fetchUsageSnapshot?.({
        provider: "openai",
        ...usageAuth(authMarkers.CODEX_APP_SERVER_AUTH_MARKER),
        timeoutMs: 3500,
        config: {},
        env: {},
        fetchFn: globalThis.fetch,
      }),
    ).resolves.toMatchObject({
      provider: "openai",
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 9, resetAt: 1_700_003_600_000 }],
      accountEmail: "codex-account@example.com",
    });
    expect(readUsage).toHaveBeenCalledWith({
      timeoutMs: 3500,
      agentDir: undefined,
      config: {},
      startOptions: expect.objectContaining({ command: "codex", commandSource: "managed" }),
    });

    await expect(
      provider.fetchUsageSnapshot?.({
        provider: "openai",
        ...usageAuth("not-codex"),
        timeoutMs: 3500,
        config: {},
        env: {},
        fetchFn: globalThis.fetch,
      }),
    ).resolves.toBeNull();
    expect(readUsage).toHaveBeenCalledOnce();
  });

  it("uses the live Codex plugin config instead of the registration snapshot", async () => {
    const readUsage = vi.fn(async () => ({ rateLimits: {} }));
    const provider = buildCodexUsageProvider({
      pluginConfig: { appServer: { command: "startup-codex" } },
      readUsage,
    });

    await provider.fetchUsageSnapshot?.({
      provider: "openai",
      ...usageAuth(authMarkers.CODEX_APP_SERVER_AUTH_MARKER),
      timeoutMs: 3500,
      config: {
        plugins: {
          entries: {
            codex: { config: { appServer: { command: "runtime-codex" } } },
          },
        },
      },
      env: {},
      fetchFn: globalThis.fetch,
    });

    expect(readUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({ command: "runtime-codex" }),
      }),
    );
  });
});
