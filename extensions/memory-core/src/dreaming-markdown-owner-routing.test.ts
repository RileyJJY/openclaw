import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { MemoryWorkspaceFiles } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecentDreamDiaryEntries } from "./dreaming-diary-file.js";
import { updateDeepDreamsFile } from "./dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function unreachable(_name: string): () => never {
  return () => {
    throw new Error("unexpected maintenance call");
  };
}

describe("dreaming managed writes route through the registered workspace owner", () => {
  let release: (() => void) | undefined;

  afterEach(() => {
    release?.();
    release = undefined;
    vi.restoreAllMocks();
  });

  async function registerOwnerWorkspace() {
    const gateway = await createTempWorkspace("dreaming-owner-gateway-");
    const harness = await createTempWorkspace("dreaming-owner-harness-");
    const twin = (file: string) => path.join(harness, path.relative(gateway, file));
    const calls = {
      stat: vi.fn(),
      readFile: vi.fn(),
      replaceReport: vi.fn(),
      writeDreams: vi.fn(),
      readDreams: vi.fn(),
    };
    const files: MemoryWorkspaceFiles = {
      assertCurrent() {},
      listFiles: unreachable("listFiles"),
      inspectFile: unreachable("inspectFile"),
      readFile: unreachable("readFile"),
      readForIndexing: unreachable("readForIndexing"),
      buildMultimodalChunk: unreachable("buildMultimodalChunk"),
      watch: unreachable("watch"),
      maintenance: {
        readFile: (file: string) => fs.readFile(twin(file)),
        stat: async (file: string, followSymlinks: boolean) => {
          calls.stat(file, followSymlinks);
          const info = followSymlinks ? await fs.stat(twin(file)) : await fs.lstat(twin(file));
          return {
            isFile: info.isFile(),
            isDirectory: info.isDirectory(),
            isSymbolicLink: info.isSymbolicLink(),
            size: info.size,
            mtimeMs: info.mtimeMs,
            mode: info.mode,
          };
        },
        listDirectory: unreachable("listDirectory"),
        mkdir: unreachable("mkdir"),
        rename: unreachable("rename"),
        resolveWritePath: unreachable("resolveWritePath"),
        commitContent: unreachable("commitContent"),
        resolveDreamsPath: async () => path.join(gateway, "DREAMS.md"),
        readDreams: (file: string) => {
          calls.readDreams(file);
          return fs.readFile(twin(file), "utf8");
        },
        writeDreams: async (file: string, content: string) => {
          calls.writeDreams(file, content);
          await fs.mkdir(path.dirname(twin(file)), { recursive: true });
          await fs.writeFile(twin(file), content, "utf8");
        },
        replaceReport: async (file: string, content: string) => {
          calls.replaceReport(file, content);
          await fs.mkdir(path.dirname(twin(file)), { recursive: true });
          await fs.writeFile(twin(file), content, "utf8");
        },
        appendCorpus: unreachable("appendCorpus"),
      },
    };
    release = registerAgentWorkspaceAccess(gateway, {
      memoryFiles: files,
      bridge: {
        readFile: unreachable("bridge.readFile"),
        writeFile: unreachable("bridge.writeFile"),
        stat: unreachable("bridge.stat"),
      },
    });
    return { gateway, harness, twin, calls };
  }

  it("routes daily inline managed writes through the maintenance owner", async () => {
    const { gateway, harness, calls } = await registerOwnerWorkspace();
    const result = await writeDailyDreamingPhaseBlock({
      workspaceDir: gateway,
      phase: "light",
      bodyLines: ["- Remote owner saw the daily block."],
      hasContent: true,
      nowMs: Date.parse("2026-04-06T03:00:00Z"),
      timezone: "UTC",
      storage: { mode: "inline", separateReports: false },
    });

    expect(result.inlinePath).toBeDefined();
    expect(calls.replaceReport).toHaveBeenCalledTimes(1);
    const [reportedPath, reportedContent] = calls.replaceReport.mock.calls[0]!;
    expect(reportedPath.startsWith(gateway)).toBe(true);
    expect(reportedContent).toContain("- Remote owner saw the daily block.");
    expect(reportedContent).toContain("<!-- openclaw:dreaming:light:start -->");
    expect(calls.writeDreams).not.toHaveBeenCalled();
    // No Gateway-local twin of the remote daily file may be created.
    await expect(fs.access(path.join(gateway, "memory"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const harnessFiles = await fs.readdir(path.join(harness, "memory"));
    expect(harnessFiles.some((name) => name.endsWith(".md"))).toBe(true);
  });

  it("routes deep managed writes through the dreams owner", async () => {
    const { gateway, harness, calls } = await registerOwnerWorkspace();
    await fs.writeFile(
      path.join(harness, "DREAMS.md"),
      "# Dream Diary\n\n## Deep Sleep\n\n<!-- openclaw:dreaming:deep:start -->\n<!-- openclaw:dreaming:deep:end -->\n",
      "utf8",
    );
    await updateDeepDreamsFile({
      workspaceDir: gateway,
      bodyLines: ["- Deep update reached the remote owner."],
    });

    expect(calls.writeDreams).toHaveBeenCalledTimes(1);
    expect(calls.replaceReport).not.toHaveBeenCalled();
    const [dreamsPath, content] = calls.writeDreams.mock.calls[0]!;
    expect(path.basename(dreamsPath)).toBe("DREAMS.md");
    expect(content).toContain("- Deep update reached the remote owner.");
    const remoteContent = await fs.readFile(path.join(harness, "DREAMS.md"), "utf8");
    expect(remoteContent).toContain("- Deep update reached the remote owner.");
    await expect(fs.access(path.join(gateway, "DREAMS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reads recent diary context through the dreams owner, not a local twin", async () => {
    const { gateway, harness, calls } = await registerOwnerWorkspace();
    await fs.writeFile(
      path.join(harness, "DREAMS.md"),
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "---",
        "",
        "*April 5, 2026*",
        "",
        "Remote diary text must reach the prompt.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf8",
    );
    // An unrelated local DREAMS.md must never shadow the registered owner.
    await fs.writeFile(path.join(gateway, "DREAMS.md"), "# Local twin must not be read.", "utf8");

    const entries = await readRecentDreamDiaryEntries({ workspaceDir: gateway, limit: 1 });
    expect(calls.readDreams).toHaveBeenCalledTimes(1);
    expect(entries).toEqual(["Remote diary text must reach the prompt."]);
  });
});
