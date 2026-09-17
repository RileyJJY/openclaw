import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const primaryModel = "grok-4.6";
const fallbackModel = "fallback-proof";
const marker = "XAI_FALLBACK_REPLY";
const scenarios = ["fallback", "no-fallback", "exhausted"] as const;
type Scenario = (typeof scenarios)[number];
const model = (id: string) => ({
  id,
  name: id,
  api: "openai-responses",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 256,
});
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

it(
  "chat.send recovers a statusless xAI failure with reported usage only through configured fallback",
  {
    timeout: 180_000,
  },
  async () => {
    const root = tempDirs.make("openclaw-xai-fallback-");
    const state = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    await Promise.all([state, workspace].map((directory) => fs.mkdir(directory)));
    for (const name of scenarios) {
      const agentDir = path.join(state, "agents", name, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "settings.json"),
        JSON.stringify({ retry: { provider: { maxRetries: 1 } } }),
      );
    }
    const configPath = path.join(state, "openclaw.json");
    const env = {
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("dist/extensions"),
    };
    const snapshot = captureEnv(Object.keys(env));
    for (const [key, value] of Object.entries(env)) {
      setTestEnvValue(key, value);
    }
    let scenario: Scenario = "fallback";
    let requests: string[] = [];
    const provider = createServer(async (request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: primaryModel }, { id: fallbackModel }] }));
        return;
      }
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/responses");
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      const payload: { model: string } = JSON.parse(body);
      requests.push(payload.model);
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (payload.model === primaryModel || scenario === "exhausted") {
        response.end(
          event({
            type: "response.failed",
            response: {
              id: `failure-${requests.length}`,
              status: "failed",
              error: { code: null, message: "Internal error during token generation" },
              output: [],
              usage: { input_tokens: 21, output_tokens: 4, total_tokens: 25 },
            },
          }),
        );
        return;
      }
      const message = {
        type: "message",
        id: "fallback",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: marker, annotations: [] }],
      };
      response.end(
        [
          event({
            type: "response.output_item.added",
            output_index: 0,
            item: { ...message, status: "in_progress", content: [] },
          }),
          event({ type: "response.output_item.done", output_index: 0, item: message }),
          event({
            type: "response.completed",
            response: {
              id: "fallback-response",
              status: "completed",
              output: [message],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          }),
        ].join(""),
      );
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        provider.once("error", reject);
        provider.listen(0, "127.0.0.1", resolve);
      });
      const address = provider.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing loopback provider address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      gateway = await startGatewayWithClient({
        cfg: {
          agents: {
            defaults: { workspace, skipBootstrap: true },
            entries: Object.fromEntries(
              scenarios.map((name) => [
                name,
                {
                  default: name === "fallback",
                  model: {
                    primary: `xai/${primaryModel}`,
                    fallbacks: name === "no-fallback" ? [] : [`openai/${fallbackModel}`],
                  },
                },
              ]),
            ),
          },
          models: {
            mode: "replace",
            providers: {
              xai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                models: [model(primaryModel)],
              },
              openai: {
                baseUrl,
                apiKey: "test",
                api: "openai-responses",
                models: [model(fallbackModel)],
              },
            },
          },
          plugins: {
            allow: ["xai", "openai"],
            slots: { memory: "none" },
            entries: { xai: { enabled: true }, openai: { enabled: true } },
          },
          logging: { file: path.join(root, "gateway.log") },
        },
        configPath,
        token: "xai-fallback-test",
      });
      const installed = getActivePluginRegistry()?.providers.find(
        (entry) => entry.provider.id === "xai",
      );
      expect(installed?.pluginId).toBe("xai");
      expect(typeof installed?.provider.classifyFailoverReason).toBe("function");
      for (const selected of scenarios) {
        scenario = selected;
        requests = [];
        const sessionKey = `agent:${scenario}:xai-fallback`;
        const started = await gateway.client.request<{ runId: string }>("chat.send", {
          sessionKey,
          message: "Reply with the marker.",
          deliver: false,
          idempotencyKey: `xai-${scenario}`,
        });
        const completed = await gateway.client.request<{ status: string }>(
          "agent.wait",
          {
            runId: started.runId,
            timeoutMs: 60_000,
          },
          { timeoutMs: 65_000 },
        );
        expect(completed.status, scenario).not.toBe("timeout");
        const history = await gateway.client.request<{
          messages: Array<{ role: string; content: unknown; stopReason?: string }>;
        }>("chat.history", { sessionKey, limit: 20 });
        const assistant = history.messages.findLast((message) => message.role === "assistant");
        expect.soft(requests[0], scenario).toBe(primaryModel);
        expect
          .soft(
            requests.filter((requested) => requested === primaryModel),
            scenario,
          )
          .toHaveLength(2);
        if (scenario === "fallback") {
          expect.soft(requests, scenario).toContain(fallbackModel);
          expect.soft(completed.status, scenario).toBe("ok");
          expect.soft(assistant?.stopReason, scenario).toBe("stop");
          expect.soft(JSON.stringify(assistant?.content), scenario).toContain(marker);
        } else {
          expect.soft(completed.status, scenario).toBe("error");
          expect.soft(JSON.stringify(assistant?.content), scenario).not.toContain(marker);
          if (scenario === "no-fallback") {
            expect.soft(requests, scenario).not.toContain(fallbackModel);
          } else {
            expect.soft(requests, scenario).toContain(fallbackModel);
          }
        }
      }
    } finally {
      try {
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close();
        }
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        snapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    }
  },
);
