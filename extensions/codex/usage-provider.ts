/** Codex app-server quota hook exposed through the provider-usage contract. */
import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  type CodexAppServerStartOptions,
  resolveCodexAppServerRuntimeOptions,
} from "./src/app-server/config.js";
import { buildCodexAppServerUsageSnapshot } from "./src/app-server/rate-limits.js";

type CodexUsageRead = {
  rateLimits: unknown;
  accountEmail?: string;
};

type CodexUsageReader = (options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<typeof requestCodexAppServerUsageLazy>[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}) => Promise<CodexUsageRead>;

type BuildCodexUsageProviderOptions = {
  pluginConfig?: unknown;
  readUsage?: CodexUsageReader;
};

/**
 * Retains the shipped app-server usage path without exposing `codex/*` as a
 * model-provider namespace. Synthetic OpenAI usage explicitly targets this hook.
 */
export function buildCodexUsageProvider(
  options: BuildCodexUsageProviderOptions = {},
): ProviderPlugin {
  return {
    id: "codex",
    label: "Codex app-server usage",
    auth: [],
    fetchUsageSnapshot: async (ctx) => {
      if (ctx.token !== CODEX_APP_SERVER_AUTH_MARKER) {
        return null;
      }
      const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "codex");
      const pluginConfig = runtimePluginConfig ?? (ctx.config ? undefined : options.pluginConfig);
      const appServer = resolveCodexAppServerRuntimeOptions({ pluginConfig });
      const usage = await (options.readUsage ?? requestCodexAppServerUsageLazy)({
        timeoutMs: ctx.timeoutMs,
        agentDir: ctx.agentDir,
        ...(ctx.authProfileId ? { authProfileId: ctx.authProfileId } : {}),
        config: ctx.config,
        startOptions: appServer.start,
      });
      const snapshot = buildCodexAppServerUsageSnapshot(usage.rateLimits);
      const accountEmail = ctx.email ?? usage.accountEmail;
      return accountEmail && !snapshot.error ? { ...snapshot, accountEmail } : snapshot;
    },
  };
}

function extractCodexAccountEmail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { account?: unknown; email?: unknown; accountEmail?: unknown };
  const account =
    record.account && typeof record.account === "object"
      ? (record.account as { email?: unknown; accountEmail?: unknown })
      : record;
  const email = account.email ?? account.accountEmail;
  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

async function requestCodexAppServerUsageLazy(options: {
  timeoutMs: number;
  agentDir?: string;
  authProfileId?: string;
  config?: Parameters<
    typeof import("./src/app-server/request.js").requestCodexAppServerJson
  >[0]["config"];
  startOptions?: CodexAppServerStartOptions;
}): Promise<CodexUsageRead> {
  const { withCodexAppServerJsonClient } = await import("./src/app-server/request.js");
  const deadline = Date.now() + options.timeoutMs;
  return await withCodexAppServerJsonClient(
    {
      timeoutMs: options.timeoutMs,
      timeoutMessage: "codex app-server usage read timed out",
      agentDir: options.agentDir,
      ...(options.authProfileId ? { authProfileId: options.authProfileId } : {}),
      config: options.config,
      startOptions: options.startOptions,
      isolated: true,
      isolatedShutdown: CODEX_USAGE_ISOLATED_SHUTDOWN,
    },
    async (request) => {
      const rateLimits = await request({ method: "account/rateLimits/read" });
      const accountEmail = await readCodexAccountEmailBestEffort(request, deadline);
      return { rateLimits, ...(accountEmail ? { accountEmail } : {}) };
    },
  );
}

// Reserve shutdown time so the optional account read cannot invalidate a
// successful rate-limit snapshot at the end of the shared deadline.
const CODEX_USAGE_ISOLATED_SHUTDOWN = { forceKillDelayMs: 200, exitTimeoutMs: 300 } as const;
const CODEX_ACCOUNT_READ_MAX_TIMEOUT_MS = 4_000;
const CODEX_ACCOUNT_READ_DEADLINE_MARGIN_MS = 250;
const CODEX_USAGE_DEADLINE_RESERVE_MS =
  CODEX_USAGE_ISOLATED_SHUTDOWN.forceKillDelayMs +
  CODEX_USAGE_ISOLATED_SHUTDOWN.exitTimeoutMs +
  CODEX_ACCOUNT_READ_DEADLINE_MARGIN_MS;

async function readCodexAccountEmailBestEffort(
  request: (params: { method: string; requestParams?: unknown }) => Promise<unknown>,
  deadline: number,
): Promise<string | undefined> {
  const boundMs = Math.min(
    CODEX_ACCOUNT_READ_MAX_TIMEOUT_MS,
    deadline - Date.now() - CODEX_USAGE_DEADLINE_RESERVE_MS,
  );
  if (boundMs <= 0) {
    return undefined;
  }
  const read = request({ method: "account/read", requestParams: {} }).then(
    (account) => extractCodexAccountEmail(account),
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), boundMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
