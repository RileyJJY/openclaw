// Memory Core provider tests cover plugin runtime integration.
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { describe, expect, it, vi } from "vitest";
import { createMemorySearchTool } from "./tools.js";

const managerDebug = {
  backend: "builtin" as const,
  purpose: "default" as const,
  managerMs: 7,
};

type MemorySearchManagerParams = {
  cfg?: OpenClawConfig;
  agentId?: string;
  purpose?: string;
  inspectSources?: boolean;
  acquireLocalService?: unknown;
};

const getMemorySearchManagerMock = vi.hoisted(() =>
  vi.fn(async (_params: MemorySearchManagerParams) => ({
    manager: null,
    debug: managerDebug,
    error: undefined,
  })),
);
const filterMemorySearchHitsBySessionVisibilityMock = vi.hoisted(() => vi.fn());
const configureMemoryCoreDreamingStateMock = vi.hoisted(() => vi.fn());

vi.mock("./memory/index.js", () => ({
  closeAllMemorySearchManagers: vi.fn(async () => {}),
  closeMemorySearchManager: vi.fn(async () => {}),
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("./tools.runtime.js", () => ({
  getMemorySearchManager: getMemorySearchManagerMock,
}));

vi.mock("./session-search-visibility.js", () => ({
  filterMemorySearchHitsBySessionVisibility: filterMemorySearchHitsBySessionVisibilityMock,
}));

vi.mock("./dreaming-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dreaming-state.js")>()),
  configureMemoryCoreDreamingState: configureMemoryCoreDreamingStateMock,
}));

import { createMemoryRuntime, memoryRuntime } from "./runtime-provider.js";

describe("memoryRuntime", () => {
  it("preserves manager debug metadata", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await memoryRuntime.getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(result.debug).toEqual(managerDebug);
    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
    });
  });

  it("forwards optional diagnostic source inspection", async () => {
    const cfg = {} as OpenClawConfig;

    await memoryRuntime.getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });

    expect(getMemorySearchManagerMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });
  });

  it("keeps local-service acquisition scoped to each runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);

    await Promise.all([
      createMemoryRuntime({ acquireLocalService: firstAcquire }).getMemorySearchManager({
        cfg,
        agentId: "first",
      }),
      createMemoryRuntime({ acquireLocalService: secondAcquire }).getMemorySearchManager({
        cfg,
        agentId: "second",
      }),
    ]);

    const firstParams = getMemorySearchManagerMock.mock.calls.find(
      ([params]) => params.agentId === "first",
    )?.[0];
    const secondParams = getMemorySearchManagerMock.mock.calls.find(
      ([params]) => params.agentId === "second",
    )?.[0];
    expect(firstParams?.acquireLocalService).toEqual(expect.any(Function));
    expect(secondParams?.acquireLocalService).toEqual(expect.any(Function));
    expect(firstParams?.acquireLocalService).not.toBe(firstAcquire);
    expect(secondParams?.acquireLocalService).not.toBe(secondAcquire);
    expect(firstParams?.acquireLocalService).not.toBe(secondParams?.acquireLocalService);

    const repeatedRuntime = createMemoryRuntime({ acquireLocalService: firstAcquire });
    await repeatedRuntime.getMemorySearchManager({ cfg, agentId: "first-again" });
    const repeatedParams = getMemorySearchManagerMock.mock.calls.find(
      ([params]) => params.agentId === "first-again",
    )?.[0];
    expect(repeatedParams?.acquireLocalService).toBe(firstParams?.acquireLocalService);
  });

  it("shares local-service acquisition identity between runtime and tool consumers", async () => {
    getMemorySearchManagerMock.mockClear();
    const cfg = {
      agents: { list: [{ id: "main", default: true }] },
    } as OpenClawConfig;
    const acquireLocalService = vi.fn(async () => undefined);

    await createMemoryRuntime({ acquireLocalService }).getMemorySearchManager({
      cfg,
      agentId: "main",
    });
    const tool = createMemorySearchTool({
      config: cfg,
      agentId: "main",
      acquireLocalService,
    });
    expect(tool).not.toBeNull();
    await tool?.execute("runtime-tool-runtime", { query: "hello" });
    await createMemoryRuntime({ acquireLocalService }).getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    const adapters = getMemorySearchManagerMock.mock.calls.map(
      ([params]) => params.acquireLocalService,
    );
    expect(adapters).toHaveLength(3);
    expect(adapters[0]).toEqual(expect.any(Function));
    expect(adapters[1]).toBe(adapters[0]);
    expect(adapters[2]).toBe(adapters[0]);
  });

  it("binds the scoped state opener inside each lazy runtime instance", async () => {
    const cfg = {} as OpenClawConfig;
    const openKeyedStore = vi.fn();
    configureMemoryCoreDreamingStateMock.mockClear();

    await createMemoryRuntime({ openKeyedStore }).getMemorySearchManager({
      cfg,
      agentId: "main",
    });

    expect(configureMemoryCoreDreamingStateMock).toHaveBeenCalledWith(openKeyedStore);
  });

  it("delegates raw-hit authorization to the canonical session visibility filter", async () => {
    const cfg = {} as OpenClawConfig;
    const hits: MemorySearchResult[] = [
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];
    filterMemorySearchHitsBySessionVisibilityMock.mockResolvedValue([]);
    await expect(
      memoryRuntime.authorizeSearchHits({
        cfg,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([]);
    expect(filterMemorySearchHitsBySessionVisibilityMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    });
  });
});
