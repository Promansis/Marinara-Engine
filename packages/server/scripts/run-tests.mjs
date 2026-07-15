// ──────────────────────────────────────────────
// Server test runner
// ──────────────────────────────────────────────
// Exists so the `test` package-script stays shell-agnostic. The natural
// inline form —
//
//   LOG_LEVEL=silent tsx --test src/.../*.test.ts
//
// is POSIX-only: cmd.exe / PowerShell read `LOG_LEVEL=silent` as a command
// name and fail with `'LOG_LEVEL' is not recognized` before a single test
// runs. Assigning the env var in JS and spawning tsx ourselves behaves
// identically on Linux, macOS, and Windows.

import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";

// Quiet the Pino logger for the run unless the caller set a level explicitly.
// Several suites deliberately exercise warn-level log paths (orphan-sweep
// failures, resume demotion, malformed tool-call ids); silencing keeps the
// runner output readable. `??=` so an explicit `LOG_LEVEL=debug` still wins.
process.env.LOG_LEVEL ??= "silent";

// Each entry is [dir-glob, extension]. The runner reads the directory and
// collects every file ending with the given extension. This keeps Windows
// compatibility (no shell glob expansion) and lets us detect zero-match
// runs before spawning; Node's test runner silently passes when every
// pattern matches nothing.
const TEST_PATTERNS = [
  [join("src", "services", "image", "__tests__"), ".test.ts"],
  [join("src", "services", "llm", "providers", "__tests__"), ".test.ts"],
  [join("src", "services", "llm", "providers", "claude-subscription", "__tests__"), ".test.ts"],
  [join("src", "services", "long-term-memory", "__tests__"), ".spec.ts"],
];

// Going through tsx's CLI entry and the current Node binary (rather than a
// bare `tsx` on PATH) keeps the runner working whether it's invoked as a
// package script or by hand, and sidesteps the platform-specific bin shim
// (`tsx` vs `tsx.cmd`) and the shell entirely.
const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// Expand patterns manually so we can detect zero-match runs before spawning.
let expandedFiles = [];
for (const [dirRel, ext] of TEST_PATTERNS) {
  const dirPath = resolve(packageRoot, dirRel);
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    continue;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    expandedFiles.push(resolve(dirPath, entry.name));
  }
}

if (expandedFiles.length === 0) {
  process.stderr.write(
    "run-tests.mjs: No test files matched any configured pattern.\n" +
    `  Patterns: ${TEST_PATTERNS.map((p) => `${p[0]}/*${p[1]}`).join(", ")}\n` +
    "  Check that tracked spec files exist and are not excluded by .gitignore.\n",
  );
  process.exit(1);
}

const relativeFiles = expandedFiles.map((f) => relative(packageRoot, f)).sort();
process.stderr.write(`run-tests.mjs: discovered ${relativeFiles.length} test file(s):\n`);
for (const name of relativeFiles) {
  process.stderr.write(`  ${name}\n`);
}

const result = spawnSync(process.execPath, [tsxCli, "--test", ...expandedFiles], {
  stdio: "inherit",
  cwd: packageRoot,
});

if (result.error) {
  // Deliberately not the shared Pino logger: this script runs under plain
  // `node` (which can't import the TypeScript logger module), and it sets
  // `LOG_LEVEL=silent` above — routing through Pino would swallow this spawn
  // failure entirely. A direct `process.stderr` write keeps the failure
  // visible without a bare `console.*` call.
  process.stderr.write(`${result.error.stack ?? result.error}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
