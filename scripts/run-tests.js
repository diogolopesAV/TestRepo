#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TEST_ROOT = "tests";
const TEST_SUFFIX = ".test.js";
const COVERAGE_THRESHOLDS = Object.freeze({
  lines: 94,
  branches: 88,
  functions: 97,
});
const SKILL_ROOT = "skills/";
const SOURCE_EXTENSION_PREFERENCES = Object.freeze({
  default: Object.freeze([".js"]),
  skill: Object.freeze([".js"]),
});

function parseArgs(argv) {
  const args = {
    coverage: false,
    help: false,
  };

  for (const token of argv) {
    if (token === "--coverage") {
      args.coverage = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectTestFiles(directoryPath, files) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(absolutePath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(TEST_SUFFIX)) {
      files.push(absolutePath);
    }
  }
}

async function discoverTestFiles(repoRoot) {
  const testsRoot = path.resolve(repoRoot, TEST_ROOT);
  if (!(await pathExists(testsRoot))) {
    return [];
  }

  const files = [];
  await collectTestFiles(testsRoot, files);
  files.sort((left, right) =>
    toPosix(path.relative(repoRoot, left)).localeCompare(
      toPosix(path.relative(repoRoot, right))
    )
  );
  return files;
}

function toPosix(filePath) {
  return filePath.split(path.sep).join("/");
}

function fromPosix(filePath) {
  return filePath.split("/").join(path.sep);
}

function getSourceCandidates(testRelativePath) {
  const sourceBaseRelativePath = testRelativePath.slice(
    `${TEST_ROOT}/`.length,
    -TEST_SUFFIX.length
  );
  const extensionPreferences = sourceBaseRelativePath.startsWith(SKILL_ROOT)
    ? SOURCE_EXTENSION_PREFERENCES.skill
    : SOURCE_EXTENSION_PREFERENCES.default;

  return extensionPreferences.map((extension) => `${sourceBaseRelativePath}${extension}`);
}

function mapTestFileToSource({ repoRoot, testFile }) {
  const testRelativePath = toPosix(path.relative(repoRoot, testFile));
  if (!testRelativePath.startsWith(`${TEST_ROOT}/`)) {
    throw new Error(
      `Test file "${testRelativePath}" must be placed under "${TEST_ROOT}/".`
    );
  }
  if (!testRelativePath.endsWith(TEST_SUFFIX)) {
    throw new Error(
      `Test file "${testRelativePath}" must end with "${TEST_SUFFIX}".`
    );
  }

  const [sourceRelativePath] = getSourceCandidates(testRelativePath);

  return {
    testFile,
    testRelativePath,
    sourceFile: path.resolve(repoRoot, fromPosix(sourceRelativePath)),
    sourceRelativePath,
  };
}

async function buildTestPlan({ repoRoot }) {
  const testFiles = await discoverTestFiles(repoRoot);
  if (testFiles.length === 0) {
    throw new Error(`No test files found under "${TEST_ROOT}/".`);
  }

  const targets = [];
  for (const testFile of testFiles) {
    const target = mapTestFileToSource({ repoRoot, testFile });
    const sourceCandidates = getSourceCandidates(target.testRelativePath);
    const existingSources = [];
    for (const sourceRelativePath of sourceCandidates) {
      const sourceFile = path.resolve(repoRoot, fromPosix(sourceRelativePath));
      if (await pathExists(sourceFile)) {
        existingSources.push(sourceRelativePath);
      }
    }

    if (existingSources.length === 0) {
      const expectedFiles = sourceCandidates.map((candidate) => `"${candidate}"`).join(" or ");
      throw new Error(
        `Test file "${target.testRelativePath}" does not map to an existing source file. Expected ${expectedFiles}.`
      );
    }

    if (existingSources.length > 1) {
      const ambiguousFiles = existingSources.map((candidate) => `"${candidate}"`).join(" and ");
      throw new Error(
        `Test file "${target.testRelativePath}" maps to multiple source files: ${ambiguousFiles}. Remove the ambiguous sibling before running tests.`
      );
    }

    const [resolvedSourceRelativePath] = existingSources;
    targets.push({
      ...target,
      sourceFile: path.resolve(repoRoot, fromPosix(resolvedSourceRelativePath)),
      sourceRelativePath: resolvedSourceRelativePath,
    });
  }

  const sourceFiles = [...new Set(targets.map((target) => target.sourceRelativePath))];

  return {
    testFiles: targets.map((target) => fromPosix(target.testRelativePath)),
    sourceFiles: sourceFiles.map((sourceFile) => fromPosix(sourceFile)),
  };
}

function buildNodeArgs(plan, options) {
  const args = [];

  if (options.coverage) {
    args.push("--experimental-test-coverage");
    for (const sourceFile of plan.sourceFiles) {
      args.push(`--test-coverage-include=${sourceFile}`);
    }
    args.push(`--test-coverage-lines=${COVERAGE_THRESHOLDS.lines}`);
    args.push(`--test-coverage-branches=${COVERAGE_THRESHOLDS.branches}`);
    args.push(`--test-coverage-functions=${COVERAGE_THRESHOLDS.functions}`);
  }

  args.push("--test");
  args.push(...plan.testFiles);
  return args;
}

async function run({ repoRoot, argv, spawn = spawnSync }) {
  const args = parseArgs(argv);
  if (args.help) {
    return {
      args,
      help: true,
      plan: null,
      result: null,
    };
  }

  const plan = await buildTestPlan({ repoRoot });
  const commandArgs = buildNodeArgs(plan, { coverage: args.coverage });
  const result = spawn(process.execPath, commandArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return {
    args,
    help: false,
    plan,
    result,
  };
}

function printUsage(output = console.log) {
  output(`Run repository tests from the mirrored top-level tests tree.

Usage:
  node scripts/run-tests.js
  node scripts/run-tests.js --coverage

Options:
  --coverage  Run the full test suite with aggregate coverage thresholds
  -h, --help  Show this help message`);
}

async function executeCli({
  repoRoot,
  argv,
  executeRun = run,
  kill = process.kill,
  output = console.log,
  errorOutput = console.error,
  processId = process.pid,
}) {
  try {
    const outcome = await executeRun({
      repoRoot,
      argv,
    });

    if (outcome.help) {
      printUsage(output);
      return 0;
    }

    if (typeof outcome.result.status === "number") {
      return outcome.result.status;
    }

    if (outcome.result.signal) {
      kill(processId, outcome.result.signal);
      return null;
    }

    return 1;
  } catch (error) {
    errorOutput(error.message);
    return 1;
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const exitCode = await executeCli({
    repoRoot,
    argv: process.argv.slice(2),
  });

  if (typeof exitCode === "number") {
    process.exitCode = exitCode;
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;

if (entryPoint && import.meta.url === entryPoint) {
  await main();
}

export const _test = {
  buildNodeArgs,
  buildTestPlan,
  discoverTestFiles,
  executeCli,
  mapTestFileToSource,
  parseArgs,
  printUsage,
  run,
  toPosix,
};
