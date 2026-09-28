import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2] ?? process.cwd();
const rawOnly = process.argv.includes("--raw");
const recoveryLimit = 64 * 1024 * 1024;
const docsPath = path.join(repoRoot, "docs/plugins/sdk-migration/compatibility-policy.md");

const deviceFilter = `
  {subscribers: (
    (.subscribers // [])
    | if type == "array" then
        [.[]
         | select(type == "object")
         | (if (.to | type) == "string" then (.to | gsub("^\\\\s+|\\\\s+$"; "")) else "" end) as $to
         | select(($to | type) == "string" and ($to | length) > 0)
         | {to: $to,
            accountId: (if (.accountId | type) == "string"
                        then (.accountId | gsub("^\\\\s+|\\\\s+$"; "") | if . == "" then null else . end)
                        else null end),
            messageThreadId: (if (.messageThreadId | type) == "string"
                              then (.messageThreadId | gsub("^\\\\s+|\\\\s+$"; "") | if . == "" then null else . end)
                              elif (.messageThreadId | type) == "number" and (.messageThreadId | isfinite)
                              then (.messageThreadId | if . >= 0 then floor else ceil end)
                              else null end),
            mode: (if .mode == "once" then "once" else "persistent" end),
            addedAtMs: (if (.addedAtMs | type) == "number" and (.addedAtMs | isfinite)
                        then (.addedAtMs | if . >= 0 then floor else ceil end)
                        else (now * 1000 | floor) end)}
         | with_entries(select(.value != null))]
      else [] end
  )}
`;

// The proof executes the filter extracted from the checked-in runbook below.
void deviceFilter;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function isSymlink(filePath) {
  return (await fs.lstat(filePath).catch(() => null))?.isSymbolicLink() ?? false;
}

async function exists(filePath) {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function extractRecoveryBlocks() {
  const docs = await fs.readFile(docsPath, "utf8");
  const recoverySection = docs.slice(docs.indexOf("### Oversized legacy JSON recovery"));
  const blocks = [...recoverySection.matchAll(/```sh\r?\n([\s\S]*?)\r?\n```/g)].map(
    (match) => match[1],
  );
  assert(blocks.length === 1, "expected one Device Pair recovery block");
  return { device: blocks[0] };
}

async function writeFixture(stateDir, { oversized }) {
  const sourcePath = path.join(stateDir, "device-pair-notify.json");
  const targetPath = `${sourcePath}.target`;
  const source = JSON.stringify({
    subscribers: [
      {
        to: " chat-recovery ",
        accountId: " telegram-default ",
        messageThreadId: " 007 ",
        mode: "once",
        addedAtMs: 1701.9,
      },
    ],
    ...(oversized ? { padding: "x".repeat(recoveryLimit) } : {}),
  });
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(targetPath, source, "utf8");
  await fs.symlink(targetPath, sourcePath);
  return { sourcePath, targetPath, source };
}

async function createProofEnvironment(tempRoot, repoRoot) {
  const homeDir = path.join(tempRoot, "home");
  const fakeBin = path.join(tempRoot, "fake-bin");
  const markerPath = path.join(tempRoot, "doctor-called");
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(path.join(homeDir, "openclaw.json"), "{}\n", "utf8");
  await fs.writeFile(
    path.join(fakeBin, "openclaw"),
    `#!/bin/sh\nprintf '%s' called > "$OPENCLAW_PROOF_DOCTOR_MARKER"\n`,
    { mode: 0o755 },
  );
  return {
    homeDir,
    fakeBin,
    markerPath,
    env: {
      ...process.env,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      OPENCLAW_CONFIG_PATH: path.join(homeDir, "openclaw.json"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
      OPENCLAW_PROOF_DOCTOR_MARKER: markerPath,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

async function installFailureCommand(fakeBin, failure) {
  if (!failure) {
    return;
  }
  const command = failure === "oversized-output" ? "jq" : failure;
  const body =
    failure === "oversized-output" ? "dd if=/dev/zero bs=1048576 count=65 2>/dev/null" : "exit 1";
  await fs.writeFile(path.join(fakeBin, command), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

async function runRecoveryBlock({ block, repoRoot, tempRoot, failure }) {
  const stateDir = path.join(tempRoot, "state");
  const fixture = await writeFixture(stateDir, {
    oversized: !failure || failure === "oversized-output",
  });
  const proofEnv = await createProofEnvironment(tempRoot, repoRoot);
  await installFailureCommand(proofEnv.fakeBin, failure);
  proofEnv.env.OPENCLAW_STATE_DIR = stateDir;
  const result = spawnSync("sh", ["-c", block], {
    cwd: repoRoot,
    env: proofEnv.env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return { result, fixture, proofEnv };
}

async function assertFailurePreservesSource({ block, repoRoot, failure, expectedMessage }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-failure-proof-"));
  try {
    const { result, fixture, proofEnv } = await runRecoveryBlock({
      block,
      repoRoot,
      tempRoot,
      failure,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const after = await fs.readFile(fixture.targetPath);
    assert(result.status !== 0, `${failure} unexpectedly succeeded`);
    assert(output.includes(expectedMessage), `${failure} did not report ${expectedMessage}`);
    assert(after.toString("utf8") === fixture.source, `${failure} changed the source bytes`);
    assert(await isSymlink(fixture.sourcePath), `${failure} replaced the source symlink`);
    assert(
      failure === "cp"
        ? !(await exists(`${fixture.sourcePath}.oversized-backup`))
        : await exists(`${fixture.sourcePath}.oversized-backup`),
      `${failure} produced an unexpected backup state`,
    );
    if (failure !== "cp") {
      const backup = await fs.readFile(`${fixture.sourcePath}.oversized-backup`, "utf8");
      assert(backup === fixture.source, `${failure} changed the backup bytes`);
    }
    assert(!(await exists(proofEnv.markerPath)), `${failure} invoked Doctor after a failed guard`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function runProductionDoctor(repoRoot, env) {
  const doctor = await import(
    pathToFileURL(path.join(repoRoot, "src/infra/state-migrations.plugin-doctor.ts"))
  );
  const migrationResult = await doctor.autoMigrateLegacyPluginDoctorState({
    config: {},
    env,
    log: { info() {}, warn() {}, error() {} },
  });
  assert(
    migrationResult.warnings.length === 0,
    `production Doctor migration warnings: ${migrationResult.warnings.join(" | ")}`,
  );
}

async function runSuccessfulProof(repoRoot, blocks) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-recovery-proof-"));
  try {
    const deviceRun = await runRecoveryBlock({
      block: blocks.device,
      repoRoot,
      tempRoot,
    });
    assert(
      deviceRun.result.status === 0,
      `Device Pair recovery failed: ${deviceRun.result.stderr}`,
    );
    assert(await exists(deviceRun.proofEnv.markerPath), "Device Pair block did not rerun Doctor");

    const deviceAfter = (await fs.stat(deviceRun.fixture.targetPath)).size;
    assert(deviceAfter <= recoveryLimit, "Device Pair recovery output exceeded 64 MiB");
    assert(
      await isSymlink(deviceRun.fixture.sourcePath),
      "Device Pair source symlink was not preserved",
    );
    assert(
      (await fs.readFile(`${deviceRun.fixture.sourcePath}.oversized-backup`, "utf8")) ===
        deviceRun.fixture.source,
      "Device Pair backup bytes changed",
    );

    await runProductionDoctor(repoRoot, deviceRun.proofEnv.env);
    const pluginState = await import(
      pathToFileURL(path.join(repoRoot, "src/plugin-state/plugin-state-store.ts"))
    );
    const deviceStore = pluginState.createPluginStateKeyedStore("device-pair", {
      namespace: "notify-subscribers",
      maxEntries: 1_024,
      env: deviceRun.proofEnv.env,
    });
    const deviceEntries = await deviceStore.entries();
    const deviceValue = deviceEntries[0]?.value;
    assert(
      deviceEntries.length === 1 &&
        deviceValue?.to === "chat-recovery" &&
        deviceValue?.accountId === "telegram-default" &&
        deviceValue?.messageThreadId === "007" &&
        deviceValue?.mode === "once" &&
        deviceValue?.addedAtMs === 1701,
      "Device Pair supported record was not preserved",
    );
    assert(
      await isSymlink(`${deviceRun.fixture.sourcePath}.migrated`),
      "Device Pair archive lost symlink form",
    );
    await pluginState.closePluginStateDatabaseAsync();
    return {
      deviceBefore: Buffer.byteLength(deviceRun.fixture.source, "utf8"),
      deviceAfter,
      deviceEntries: deviceEntries.length,
      archives: true,
      backups: true,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const blocks = await extractRecoveryBlocks();
  if (rawOnly) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-raw-recovery-proof-"));
    try {
      const stateDir = path.join(tempRoot, "state");
      const proofEnv = await createProofEnvironment(tempRoot, repoRoot);
      const device = await writeFixture(stateDir, { oversized: true });
      proofEnv.env.OPENCLAW_STATE_DIR = stateDir;
      const beforeDevice = device.source;
      const doctor = await import(
        pathToFileURL(path.join(repoRoot, "src/infra/state-migrations.plugin-doctor.ts"))
      );
      const result = await doctor.autoMigrateLegacyPluginDoctorState({
        config: {},
        env: proofEnv.env,
        log: { info() {}, warn() {}, error() {} },
      });
      assert(
        result.warnings.length === 1,
        "raw oversized Device Pair source did not remain blocked",
      );
      assert(
        (await fs.readFile(device.targetPath, "utf8")) === beforeDevice,
        "raw Device Pair source changed",
      );
      assert(await isSymlink(device.sourcePath), "raw Device Pair source symlink changed");
      assert(!(await exists(`${device.sourcePath}.migrated`)), "raw source archived unexpectedly");
      console.log(
        JSON.stringify({
          testedHead: spawnSync("git", ["rev-parse", "HEAD"], {
            cwd: repoRoot,
            encoding: "utf8",
          }).stdout.trim(),
          deviceBytes: Buffer.byteLength(beforeDevice, "utf8"),
          warnings: result.warnings.length,
          sourcePreserved: true,
          archived: false,
        }),
      );
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
    return;
  }

  const success = await runSuccessfulProof(repoRoot, blocks);
  for (const [failure, expectedMessage] of [
    ["cp", "Backup failed"],
    ["jq", "Compaction failed"],
    ["wc", "Cannot measure recovery output"],
    ["oversized-output", "Recovery output is"],
    ["mv", "Replacement failed"],
  ]) {
    await assertFailurePreservesSource({
      block: blocks.device,
      repoRoot,
      failure,
      expectedMessage,
    });
  }
  console.log(
    JSON.stringify({
      testedHead: spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).stdout.trim(),
      ...success,
      recoveryBlocksExecuted: ["device-pair"],
      failurePaths: ["backup", "jq", "size-check", "oversized-output", "replacement"],
      failureSourcesPreserved: true,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
