// Comfy workflow file helpers preserve the direct UTF-8 read for unconfigured
// workflowPath files and bound local reads when the operator configures an
// explicit workflowFileMaxBytes limit.
import fs from "node:fs/promises";
import { FsSafeError, readRegularFile } from "openclaw/plugin-sdk/security-runtime";

export type ComfyWorkflowConfigRoot = "models.providers.comfy" | "plugins.entries.comfy.config";

export async function readComfyWorkflowFile(
  filePath: string,
  maxBytes: number | undefined,
  options: { configRoot?: ComfyWorkflowConfigRoot } = {},
): Promise<string> {
  if (maxBytes === undefined) {
    return fs.readFile(filePath, "utf8");
  }
  try {
    return (await readRegularFile({ filePath, maxBytes })).buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "too-large") {
      throw workflowFileTooLargeError(
        filePath,
        maxBytes,
        options.configRoot ?? "plugins.entries.comfy.config",
        error,
      );
    }
    throw error;
  }
}

function workflowFileTooLargeError(
  filePath: string,
  maxBytes: number,
  configRoot: ComfyWorkflowConfigRoot,
  cause?: unknown,
): Error {
  const guidance =
    configRoot === "models.providers.comfy"
      ? "migrate the complete models.providers.comfy configuration to plugins.entries.comfy.config before setting plugins.entries.comfy.config.workflowFileMaxBytes; adding only a partial plugin config takes precedence over the legacy root"
      : "raise the plugins.entries.comfy.config.workflowFileMaxBytes setting";
  return new Error(
    `Comfy workflow at ${filePath} exceeds ${maxBytes} bytes; ${guidance} only when the downstream Comfy service accepts the larger serialized prompt request`,
    { cause },
  );
}
