import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = process.argv[2] ?? process.cwd();
const rawOnly = process.argv.includes("--raw");
const recoveryLimit = 64 * 1024 * 1024;

const activeFilter = `
  {sessions: (
    (.sessions // {})
    | if type == "object" then
        [to_entries[]
         | select((.key | type) == "string" and (.key | length) > 0)
         | select((.value | type) == "object" and .value.disabled == true)
         | {key: .key, value: {
             sessionKey: .key,
             disabled: true,
             updatedAt: (if (.value.updatedAt | type) == "number" and (.value.updatedAt | isfinite)
                         then .value.updatedAt else (now * 1000 | floor) end)
           }}]
        | from_entries
      else {} end
  )}
`;

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

async function compactWithJq(source, target, filter) {
  const result = spawnSync("jq", ["-e", filter, source], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`jq failed: ${result.stderr}`);
  }
  await fs.writeFile(target, result.stdout, "utf8");
  const size = (await fs.stat(target)).size;
  if (size > recoveryLimit) {
    throw new Error(`recovery output is ${size} bytes, above ${recoveryLimit}`);
  }
  return size;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-recovery-proof-"));
  const stateDir = path.join(tempRoot, "state");
  const homeDir = path.join(tempRoot, "home");
  const configPath = path.join(homeDir, "openclaw.json");
  const activePath = path.join(stateDir, "plugins", "active-memory", "session-toggles.json");
  const activeTarget = `${activePath}.target`;
  const devicePath = path.join(stateDir, "device-pair-notify.json");
  const deviceTarget = `${devicePath}.target`;
  const env = {
    ...process.env,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
  };

  const activeSource = JSON.stringify({
    sessions: {
      "telegram:dm:recovery": { disabled: true, updatedAt: 1700 },
      __padding__: { disabled: false, updatedAt: 0, note: "x".repeat(recoveryLimit) },
    },
  });
  const deviceSource = JSON.stringify({
    subscribers: [
      {
        to: " chat-recovery ",
        accountId: " telegram-default ",
        messageThreadId: " 007 ",
        mode: "once",
        addedAtMs: 1701.9,
      },
    ],
    notifiedRequestIds: { stale: 1702 },
    padding: "x".repeat(recoveryLimit),
  });

  try {
    await fs.mkdir(path.dirname(activePath), { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    await fs.writeFile(configPath, "{}\n", "utf8");
    await fs.writeFile(activeTarget, activeSource, "utf8");
    await fs.symlink(activeTarget, activePath);
    await fs.writeFile(deviceTarget, deviceSource, "utf8");
    await fs.symlink(deviceTarget, devicePath);

    const activeBefore = Buffer.byteLength(activeSource, "utf8");
    const deviceBefore = Buffer.byteLength(deviceSource, "utf8");
    let activeAfter = activeBefore;
    let deviceAfter = deviceBefore;
    if (!rawOnly) {
      await fs.copyFile(activePath, `${activePath}.oversized-backup`);
      await fs.copyFile(devicePath, `${devicePath}.oversized-backup`);
      const activeTemp = `${await fs.realpath(activePath)}.recovery`;
      const deviceTemp = `${await fs.realpath(devicePath)}.recovery`;
      activeAfter = await compactWithJq(activePath, activeTemp, activeFilter);
      deviceAfter = await compactWithJq(devicePath, deviceTemp, deviceFilter);
      await fs.rename(activeTemp, await fs.realpath(activePath));
      await fs.rename(deviceTemp, await fs.realpath(devicePath));
    }

    const doctor = await import(
      pathToFileURL(path.join(repoRoot, "src/infra/state-migrations.plugin-doctor.ts"))
    );
    const migrationResult = await doctor.autoMigrateLegacyPluginDoctorState({
      config: {},
      env,
      log: { info() {}, warn() {}, error() {} },
    });
    if (migrationResult.warnings.length > 0) {
      throw new Error(
        `production Doctor migration warnings: ${migrationResult.warnings.join(" | ")}`,
      );
    }

    const pluginState = await import(
      pathToFileURL(path.join(repoRoot, "src/plugin-state/plugin-state-store.ts"))
    );
    const activeStore = pluginState.createPluginStateKeyedStore("active-memory", {
      namespace: "session-toggles",
      maxEntries: 10_000,
      env,
    });
    const deviceStore = pluginState.createPluginStateKeyedStore("device-pair", {
      namespace: "notify-subscribers",
      maxEntries: 1_024,
      env,
    });
    const activeEntries = await activeStore.entries();
    const deviceEntries = await deviceStore.entries();
    const activeValue = activeEntries[0]?.value;
    const deviceValue = deviceEntries[0]?.value;
    if (
      activeEntries.length !== 1 ||
      activeValue?.sessionKey !== "telegram:dm:recovery" ||
      activeValue?.disabled !== true ||
      deviceEntries.length !== 1 ||
      deviceValue?.to !== "chat-recovery" ||
      deviceValue?.accountId !== "telegram-default" ||
      deviceValue?.messageThreadId !== "007" ||
      deviceValue?.mode !== "once" ||
      deviceValue?.addedAtMs !== 1701
    ) {
      throw new Error(
        `supported records were not preserved: ${JSON.stringify({ activeValue, deviceValue })}`,
      );
    }
    const activeBackup = await fs.access(`${activePath}.oversized-backup`).then(
      () => true,
      () => false,
    );
    const deviceBackup = await fs.access(`${devicePath}.oversized-backup`).then(
      () => true,
      () => false,
    );
    const activeArchive = await fs.access(`${activePath}.migrated`).then(
      () => true,
      () => false,
    );
    const deviceArchive = await fs.access(`${devicePath}.migrated`).then(
      () => true,
      () => false,
    );
    const activeArchiveSymlink =
      (await fs.lstat(`${activePath}.migrated`).catch(() => null))?.isSymbolicLink() ?? false;
    const deviceArchiveSymlink =
      (await fs.lstat(`${devicePath}.migrated`).catch(() => null))?.isSymbolicLink() ?? false;
    pluginState.closePluginStateDatabase();
    console.log(
      JSON.stringify({
        testedHead: spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).stdout.trim(),
        activeBefore,
        activeAfter,
        deviceBefore,
        deviceAfter,
        activeEntries: activeEntries.length,
        deviceEntries: deviceEntries.length,
        activeBackup,
        deviceBackup,
        activeArchive,
        deviceArchive,
        activeArchiveSymlink,
        deviceArchiveSymlink,
        activeSourceSymlink:
          (await fs.lstat(activePath).catch(() => null))?.isSymbolicLink() ?? false,
        deviceSourceSymlink:
          (await fs.lstat(devicePath).catch(() => null))?.isSymbolicLink() ?? false,
      }),
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((/** @type {unknown} */ error) => {
  console.error(error);
  process.exitCode = 1;
});
