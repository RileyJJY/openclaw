#!/usr/bin/env node

// Validates docs i18n glossary terms against configured usage rules.
import fs from "node:fs";
import path from "node:path";
import { requireOptionArgument } from "./lib/arg-utils.mts";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";

const ROOT = process.cwd();
const GLOSSARY_PATH = path.join(ROOT, "docs", ".i18n", "glossary.zh-CN.json");
const DOC_FILE_RE = /^docs\/(?!zh-CN\/).+\.(md|mdx)$/i;
const LIST_ITEM_LINK_RE = /^\s*(?:[-*]|\d+\.)\s+\[([^\]]+)\]\((\/[^)]+)\)/;
const MAX_TITLE_WORDS = 8;
const MAX_LABEL_WORDS = 6;
const MAX_TERM_LENGTH = 80;
const GIT_TIMEOUT_MS = 60_000;
const TERMINAL_GIT_EXIT_CODES = new Set([
  signalExitCode("SIGHUP"),
  signalExitCode("SIGINT"),
  signalExitCode("SIGTERM"),
]);

type TermMatch = {
  file: string;
  line: number;
  kind: "title" | "link label";
  term: string;
};

export function parseArgs(argv: string[]) {
  const args = { base: "", head: "" };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") {
      args.base = requireOptionArgument(argv, i, "--base");
      i += 1;
      continue;
    }
    if (argv[i] === "--head") {
      args.head = requireOptionArgument(argv, i, "--head");
      i += 1;
    }
  }
  return args;
}

type GitFailure = Error & { exitCode: number | null; timedOut: boolean };
type GitRunnerOptions = {
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};
type GitRunner = (args: string[]) => Promise<string>;

function formatGitArgs(args: string[]) {
  return args.join(" ");
}

function gitExitCode(error: unknown) {
  if (!(error instanceof Error) || !("exitCode" in error)) {
    return null;
  }
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : null;
}

function isTerminalGitFailure(error: unknown) {
  const exitCode = gitExitCode(error);
  return exitCode !== null && TERMINAL_GIT_EXIT_CODES.has(exitCode);
}

function createGitError(args: string[], error: unknown, timeoutMs: number): GitFailure {
  const metadata =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown; signal?: unknown; stderr?: unknown })
      : {};
  const exitCode =
    typeof metadata.code === "number" && Number.isSafeInteger(metadata.code) ? metadata.code : null;
  const details = error instanceof Error ? error.message : String(error);
  const timedOut =
    metadata.code === "ETIMEDOUT" ||
    metadata.signal === "SIGTERM" ||
    /timed out|timeout/i.test(details);
  const stderr = typeof metadata.stderr === "string" ? metadata.stderr.trim() : "";
  let message: string;
  if (timedOut) {
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} timed out after ${timeoutMs}ms.`;
  } else if (stderr) {
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} failed: ${stderr}`;
  } else {
    // Raw spawn and process-tree cleanup failures can reject without stderr;
    // keep the runner's cause so a missing git executable or failed cleanup
    // stays actionable instead of degrading to a generic command failure.
    message = `docs:check-i18n-glossary: git ${formatGitArgs(args)} failed${details ? `: ${details}` : "."}`;
  }
  const wrapped = new Error(message, { cause: error }) as GitFailure;
  wrapped.exitCode = exitCode;
  wrapped.timedOut = timedOut;
  return wrapped;
}

/**
 * Test code can inject a short timeout and isolated PATH without adding a
 * production environment/config surface.
 */
export function createGitRunner(options: GitRunnerOptions = {}) {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const cwd = options.cwd ?? ROOT;
  const env = options.env ?? process.env;
  return async (args: string[]) => {
    let stdout = "";
    let stderr = "";
    let status: number;
    try {
      status = await runManagedCommand({
        bin: "git",
        args,
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        // Git takes its refs and paths as direct argv; cmd.exe wrapping would
        // reject legal Windows documentation pathnames such as `docs/a&b.md`.
        shell: false,
        timeoutMs,
        onReady: (child) => {
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr?.setEncoding("utf8");
          child.stderr?.on("data", (chunk) => {
            stderr += chunk;
          });
        },
      });
    } catch (error) {
      throw createGitError(args, error, timeoutMs);
    }
    if (status !== 0) {
      throw createGitError(
        args,
        Object.assign(new Error(`git exited with code ${status}`), {
          code: status,
          stderr,
        }),
        timeoutMs,
      );
    }
    return stdout.trim();
  };
}

const runGit = createGitRunner();

async function resolveBase(explicitBase: string) {
  if (explicitBase) {
    return explicitBase;
  }

  const envBase = process.env.DOCS_I18N_GLOSSARY_BASE?.trim();
  if (envBase) {
    return envBase;
  }

  for (const candidate of ["origin/main", "fork/main", "main"]) {
    try {
      return await runGit(["merge-base", candidate, "HEAD"]);
    } catch (error) {
      if (
        (error instanceof Error && "timedOut" in error && error.timedOut === true) ||
        isTerminalGitFailure(error)
      ) {
        throw error;
      }
      // Try the next candidate.
    }
  }

  return "";
}

async function listChangedDocs(base: string, head: string) {
  const args = ["diff", "--name-only", "--diff-filter=ACMR", base];
  if (head) {
    args.push(head);
  }
  args.push("--", "docs");

  return (await runGit(args))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => DOC_FILE_RE.test(line));
}

function loadGlossarySources() {
  const data = fs.readFileSync(GLOSSARY_PATH, "utf8");
  const entries: unknown = JSON.parse(data);
  if (!Array.isArray(entries)) {
    throw new Error(`${GLOSSARY_PATH} must contain an array`);
  }
  return new Set(
    entries
      .map((entry) =>
        entry && typeof entry === "object" && "source" in entry ? String(entry.source).trim() : "",
      )
      .filter(Boolean),
  );
}

function containsLatin(text: string) {
  return /[A-Za-z]/.test(text);
}

function wordCount(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function unquoteScalar(raw: string) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function isGlossaryCandidate(term: string, maxWords: number) {
  if (!term) {
    return false;
  }
  if (!containsLatin(term)) {
    return false;
  }
  if (term.includes("`")) {
    return false;
  }
  if (term.length > MAX_TERM_LENGTH) {
    return false;
  }
  return wordCount(term) <= maxWords;
}

/**
 * Reads a file from the merge-base revision. A machine-readable `git ls-tree`
 * result decides whether an absent base file should use the empty fallback;
 * all other git failures, including timeouts, propagate to the caller.
 */
export async function readGitFile(base: string, relPath: string, git: GitRunner = runGit) {
  const listing = await git(["ls-tree", base, "--", `:(literal)${relPath}`]);
  if (listing === "") {
    return "";
  }
  return await git(["show", `${base}:${relPath}`]);
}

function extractTerms(file: string, text: string) {
  const terms = new Map<string, TermMatch>();
  const lines = text.split("\n");

  if (lines[0]?.trim() === "---") {
    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line?.trim() === "---") {
        break;
      }

      const match = line?.match(/^title:\s*(.+)\s*$/);
      if (!match) {
        continue;
      }

      const title = unquoteScalar(match[1] ?? "");
      if (isGlossaryCandidate(title, MAX_TITLE_WORDS)) {
        terms.set(title, { file, line: index + 1, kind: "title", term: title });
      }
      break;
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(LIST_ITEM_LINK_RE);
    if (!match) {
      continue;
    }

    const label = (match[1] ?? "").trim();
    if (!isGlossaryCandidate(label, MAX_LABEL_WORDS)) {
      continue;
    }

    if (!terms.has(label)) {
      terms.set(label, { file, line: index + 1, kind: "link label", term: label });
    }
  }

  return terms;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = await resolveBase(args.base);

  if (!base) {
    console.warn(
      "docs:check-i18n-glossary: no merge base found; skipping glossary coverage check.",
    );
    process.exit(0);
  }

  const changedDocs = await listChangedDocs(base, args.head);
  if (changedDocs.length === 0) {
    process.exit(0);
  }

  const glossary = loadGlossarySources();
  const missing: TermMatch[] = [];

  for (const relPath of changedDocs) {
    const absPath = path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }

    const currentTerms = extractTerms(relPath, fs.readFileSync(absPath, "utf8"));
    const baseTerms = extractTerms(relPath, await readGitFile(base, relPath));

    for (const [term, match] of currentTerms) {
      if (baseTerms.has(term)) {
        continue;
      }
      if (glossary.has(term)) {
        continue;
      }
      missing.push(match);
    }
  }

  if (missing.length === 0) {
    process.exit(0);
  }

  console.error("docs:check-i18n-glossary: missing zh-CN glossary entries for changed doc labels:");
  for (const match of missing) {
    console.error(`- ${match.file}:${match.line} ${match.kind} "${match.term}"`);
  }
  console.error("");
  console.error(
    "Add exact source terms to docs/.i18n/glossary.zh-CN.json before rerunning docs-i18n.",
  );
  console.error(`Checked changed English docs relative to ${base}.`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(isTerminalGitFailure(error) ? (gitExitCode(error) ?? 1) : 1);
  }
}
