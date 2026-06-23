#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GENERAL_HUB_NAME,
  assertUniqueSkillNames,
  discoverRepoSkills,
  toPosix,
} from "./lib/skills-repo.js";

const DEFAULT_HUBS_DIR = "hubs";
const DEFAULT_LOCAL_SOURCE_PATH = "github.com/diogolopesAV/TestRepo/skills";
const DEFAULT_ROOT_HUB_FILE = "skillshare-hub.json";
const DEFAULT_SKILLS_ROOT = "skills";
const VALID_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VALID_TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const repoRoot = process.cwd();
  const generated = await buildGeneratedHubFiles({ repoRoot });

  if (args.check) {
    const issues = await checkGeneratedHubFiles({
      repoRoot,
      expectedFiles: generated.files,
    });

    if (issues.length > 0) {
      for (const issue of issues) {
        console.error(`[ERROR] ${issue}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("[OK] Skillshare hub files are up to date.");
    return;
  }

  await writeGeneratedHubFiles({
    repoRoot,
    expectedFiles: generated.files,
  });

  console.log(
    `[OK] Wrote ${generated.files.size} skillshare hub file(s): ${[
      ...generated.files.keys(),
    ].join(", ")}`
  );
}

function parseArgs(argv) {
  const args = {
    check: false,
    help: false,
  };

  for (const token of argv) {
    if (token === "--check") {
      args.check = true;
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

async function buildGeneratedHubFiles({
  repoRoot,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  hubsDir = DEFAULT_HUBS_DIR,
  localSourcePath = DEFAULT_LOCAL_SOURCE_PATH,
  rootHubFile = DEFAULT_ROOT_HUB_FILE,
} = {}) {
  const publicSkills = (await discoverRepoSkills({
    repoRoot,
    skillsRoot,
  })).filter((skill) => !skill.isInternal);

  assertUniqueSkillNames(publicSkills);

  const localEntriesByHub = new Map();
  for (const skill of publicSkills) {
    pushEntry(
      localEntriesByHub,
      skill.hubName,
      buildLocalHubEntry(skill, { skillsRoot })
    );
  }

  const externalEntriesByHub = await loadExternalHubEntries({
    repoRoot,
    skillsRoot,
  });

  const hubNames = new Set([
    ...localEntriesByHub.keys(),
    ...externalEntriesByHub.keys(),
  ]);

  const hubDocuments = [];
  for (const hubName of [...hubNames].sort((left, right) => left.localeCompare(right))) {
    const entries = [
      ...(localEntriesByHub.get(hubName) || []),
      ...(externalEntriesByHub.get(hubName) || []),
    ].map((entry) => normalizeHubEntry(entry));

    assertUniqueNamesWithinHub(entries, { hubName });

    hubDocuments.push({
      hubName,
      document: {
        schemaVersion: 1,
        sourcePath: localSourcePath,
        skills: sortHubEntries(entries),
      },
    });
  }

  const rootDocument = buildRootHubDocument(hubDocuments, {
    sourcePath: localSourcePath,
  });
  const files = new Map();

  for (const hubDocument of hubDocuments) {
    files.set(
      toPosix(path.join(hubsDir, `${hubDocument.hubName}.json`)),
      serializeJson(hubDocument.document)
    );
  }
  files.set(rootHubFile, serializeJson(rootDocument));

  return {
    hubDocuments,
    rootDocument,
    files,
  };
}

async function loadExternalHubEntries({ repoRoot, skillsRoot }) {
  const skillsRootAbs = path.resolve(repoRoot, skillsRoot);
  const entriesByHub = new Map();

  const rootManifestAbs = path.join(skillsRootAbs, "external.json");
  if (await fileExists(rootManifestAbs)) {
    entriesByHub.set(
      GENERAL_HUB_NAME,
      await loadExternalManifest({
        manifestAbs: rootManifestAbs,
        sourceLabel: toPosix(path.relative(repoRoot, rootManifestAbs)),
      })
    );
  }

  const rootEntries = await safeReadDir(skillsRootAbs);
  for (const rootEntry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!rootEntry.isDirectory()) {
      continue;
    }

    const groupDirAbs = path.join(skillsRootAbs, rootEntry.name);
    if (await fileExists(path.join(groupDirAbs, "SKILL.md"))) {
      continue;
    }

    const manifestAbs = path.join(groupDirAbs, "external.json");
    if (!(await fileExists(manifestAbs))) {
      continue;
    }

    entriesByHub.set(
      rootEntry.name,
      await loadExternalManifest({
        manifestAbs,
        sourceLabel: toPosix(path.relative(repoRoot, manifestAbs)),
      })
    );
  }

  return entriesByHub;
}

async function loadExternalManifest({ manifestAbs, sourceLabel }) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(manifestAbs, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${sourceLabel}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceLabel} must contain a JSON array of skill entries.`);
  }

  return parsed.map((entry, index) => {
    const normalizedEntry = validateHubEntry(entry, {
      sourceLabel: `${sourceLabel}[${index}]`,
      allowUnknownFields: false,
    });

    assertExplicitHubSource(normalizedEntry.source, {
      sourceLabel: `${sourceLabel}[${index}]`,
    });

    return normalizedEntry;
  });
}

function buildLocalHubEntry(skill, { skillsRoot }) {
  const tags = readRequiredSkillshareTags(skill, skill.skillMdRel);

  const entry = {
    name: skill.name,
    description: skill.description,
    source: buildLocalSkillSource(skill, { skillsRoot }),
    tags,
  };

  return validateHubEntry(entry, {
    sourceLabel: skill.skillMdRel,
    allowUnknownFields: false,
  });
}

function readRequiredSkillshareTags(skill, sourceLabel) {
  const rawValue = skill.metadata?.["skillshare-tags"];
  if (typeof rawValue !== "string" || rawValue.trim() === "") {
    throw new Error(
      `${sourceLabel} must define metadata.skillshare-tags for published skill "${skill.name}".`
    );
  }

  const rawTags = rawValue.split(",").map((tag) => tag.trim());
  if (rawTags.some((tag) => tag === "")) {
    throw new Error(
      `${sourceLabel} must define metadata.skillshare-tags as comma-separated non-empty tags.`
    );
  }

  const uniqueTags = new Set();
  for (const tag of rawTags) {
    if (!VALID_TAG_PATTERN.test(tag)) {
      throw new Error(
        `${sourceLabel} has invalid metadata.skillshare-tags value "${tag}". Use lowercase letters, numbers, and hyphens only.`
      );
    }
    if (uniqueTags.has(tag)) {
      throw new Error(
        `${sourceLabel} has duplicate metadata.skillshare-tags value "${tag}".`
      );
    }
    uniqueTags.add(tag);
  }

  if (uniqueTags.size < 1 || uniqueTags.size > 5) {
    throw new Error(
      `${sourceLabel} must define between 1 and 5 unique metadata.skillshare-tags values.`
    );
  }

  return [...uniqueTags].sort((left, right) => left.localeCompare(right));
}

function buildLocalSkillSource(skill, { skillsRoot }) {
  const normalizedSkillsRoot = `${toPosix(skillsRoot).replace(/\/+$/u, "")}/`;
  if (!skill.skillDirRel.startsWith(normalizedSkillsRoot)) {
    throw new Error(
      `Cannot derive local hub source for ${skill.skillDirRel} outside ${normalizedSkillsRoot}`
    );
  }

  return skill.skillDirRel.slice(normalizedSkillsRoot.length);
}

function validateHubEntry(
  entry,
  { sourceLabel = "unknown entry", allowUnknownFields = false } = {}
) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${sourceLabel} must be an object.`);
  }

  const allowedKeys = new Set(["description", "name", "skill", "source", "tags"]);
  if (!allowUnknownFields) {
    for (const key of Object.keys(entry)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`${sourceLabel} contains unsupported field "${key}".`);
      }
    }
  }

  const name = readRequiredString(entry.name, "name", sourceLabel);
  if (!VALID_SKILL_NAME_PATTERN.test(name)) {
    throw new Error(
      `${sourceLabel} has invalid name "${name}". Use lowercase letters, numbers, and hyphens only.`
    );
  }

  const description = readRequiredString(entry.description, "description", sourceLabel);
  const source = readRequiredString(entry.source, "source", sourceLabel);
  const skill = readOptionalString(entry.skill, "skill", sourceLabel);
  const tags = readOptionalTags(entry.tags, sourceLabel);

  const normalizedEntry = {
    name,
    description,
    source,
  };

  if (skill) {
    normalizedEntry.skill = skill;
  }
  if (tags.length > 0) {
    normalizedEntry.tags = tags;
  }

  return normalizedEntry;
}

function normalizeHubEntry(entry) {
  return validateHubEntry(entry, {
    sourceLabel: entry.name || "hub entry",
    allowUnknownFields: false,
  });
}

function assertUniqueNamesWithinHub(entries, { hubName }) {
  const seenNames = new Set();

  for (const entry of entries) {
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate skill name in hub "${hubName}": ${entry.name}`);
    }
    seenNames.add(entry.name);
  }
}

function buildRootHubDocument(
  hubDocuments,
  { sourcePath = DEFAULT_LOCAL_SOURCE_PATH } = {}
) {
  const entriesByName = new Map();

  for (const hubDocument of hubDocuments) {
    for (const entry of hubDocument.document.skills) {
      const existing = entriesByName.get(entry.name);
      if (!existing) {
        entriesByName.set(entry.name, {
          entry,
          hubName: hubDocument.hubName,
        });
        continue;
      }

      if (!canMergeRootEntries(existing.entry, entry)) {
        throw new Error(
          `Conflicting skill name "${entry.name}" across hubs ` +
            `"${existing.hubName}" and "${hubDocument.hubName}".`
        );
      }

      existing.entry = mergeRootEntries(existing.entry, entry);
    }
  }

  return {
    schemaVersion: 1,
    sourcePath,
    skills: sortHubEntries([...entriesByName.values()].map((value) => value.entry)),
  };
}

function canMergeRootEntries(left, right) {
  return (
    left.name === right.name &&
    left.description === right.description &&
    left.source === right.source &&
    (left.skill || "") === (right.skill || "")
  );
}

function mergeRootEntries(left, right) {
  const mergedTags = mergeTags(left.tags || [], right.tags || []);
  const merged = {
    name: left.name,
    description: left.description,
    source: left.source,
  };

  if (left.skill) {
    merged.skill = left.skill;
  }
  if (mergedTags.length > 0) {
    merged.tags = mergedTags;
  }

  return merged;
}

function mergeTags(left, right) {
  return [...new Set([...left, ...right])].sort((a, b) => a.localeCompare(b));
}

function sortHubEntries(entries) {
  return [...entries].sort((left, right) => {
    if (left.name !== right.name) {
      return left.name.localeCompare(right.name);
    }
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }
    return (left.skill || "").localeCompare(right.skill || "");
  });
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeGeneratedHubFiles({ repoRoot, expectedFiles }) {
  const hubsDirAbs = path.resolve(repoRoot, DEFAULT_HUBS_DIR);
  await fs.mkdir(hubsDirAbs, { recursive: true });

  for (const [fileRel, content] of expectedFiles) {
    const fileAbs = path.resolve(repoRoot, fileRel);
    await fs.mkdir(path.dirname(fileAbs), { recursive: true });
    await fs.writeFile(fileAbs, content, "utf8");
  }

  const expectedHubFiles = new Set(
    [...expectedFiles.keys()].filter((fileRel) => fileRel.startsWith(`${DEFAULT_HUBS_DIR}/`))
  );
  const existingHubFiles = await listExistingHubFiles({ repoRoot });
  for (const fileRel of existingHubFiles) {
    if (!expectedHubFiles.has(fileRel)) {
      await fs.unlink(path.resolve(repoRoot, fileRel));
    }
  }
}

async function checkGeneratedHubFiles({ repoRoot, expectedFiles }) {
  const issues = [];

  for (const [fileRel, expectedContent] of expectedFiles) {
    const fileAbs = path.resolve(repoRoot, fileRel);
    let actualContent;
    try {
      actualContent = await fs.readFile(fileAbs, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        issues.push(`Missing generated file: ${fileRel}`);
        continue;
      }
      throw error;
    }

    if (actualContent !== expectedContent) {
      issues.push(`Generated file is stale: ${fileRel}`);
    }
  }

  const expectedHubFiles = new Set(
    [...expectedFiles.keys()].filter((fileRel) => fileRel.startsWith(`${DEFAULT_HUBS_DIR}/`))
  );
  const existingHubFiles = await listExistingHubFiles({ repoRoot });
  for (const fileRel of existingHubFiles) {
    if (!expectedHubFiles.has(fileRel)) {
      issues.push(`Unexpected generated file: ${fileRel}`);
    }
  }

  return issues;
}

async function listExistingHubFiles({ repoRoot }) {
  const hubsDirAbs = path.resolve(repoRoot, DEFAULT_HUBS_DIR);
  const dirEntries = await safeReadDir(hubsDirAbs);

  return dirEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => toPosix(path.join(DEFAULT_HUBS_DIR, entry.name)))
    .sort((left, right) => left.localeCompare(right));
}

function pushEntry(entriesByHub, hubName, entry) {
  const existing = entriesByHub.get(hubName);
  if (existing) {
    existing.push(entry);
    return;
  }
  entriesByHub.set(hubName, [entry]);
}

function readRequiredString(value, key, sourceLabel) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${sourceLabel} must define a non-empty string "${key}".`);
  }
  return value.trim();
}

function readOptionalString(value, key, sourceLabel) {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${sourceLabel} must define "${key}" as a non-empty string when present.`);
  }
  return value.trim();
}

function readOptionalTags(value, sourceLabel) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${sourceLabel} must define "tags" as an array when present.`);
  }

  const tags = value.map((tag, index) => {
    if (typeof tag !== "string" || tag.trim() === "") {
      throw new Error(`${sourceLabel} has invalid tags[${index}].`);
    }
    return tag.trim();
  });

  return [...new Set(tags)].sort((left, right) => left.localeCompare(right));
}

function assertExplicitHubSource(source, { sourceLabel }) {
  if (isExplicitHubSource(source)) {
    return;
  }

  throw new Error(
    `${sourceLabel} must use an explicit host-qualified, URL, or absolute source so it is not resolved relative to sourcePath.`
  );
}

function isExplicitHubSource(source) {
  if (
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("file://") ||
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  ) {
    return true;
  }

  const firstSegment = source.split("/")[0] || "";
  return /^[a-z0-9.-]+\.[a-z0-9.-]+$/iu.test(firstSegment);
}

async function fileExists(fileAbs) {
  try {
    await fs.access(fileAbs);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function safeReadDir(dirAbs) {
  try {
    return await fs.readdir(dirAbs, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw new Error(`Failed to read directory ${dirAbs}: ${error.message}`);
  }
}

function printUsage() {
  console.log(`Usage:
  node scripts/build-skillshare-hubs.js
  node scripts/build-skillshare-hubs.js --check

Options:
  --check     Validate generated hub files without writing them
  --help, -h  Show this help
`);
}

export const _test = {
  parseArgs,
  buildGeneratedHubFiles,
  loadExternalHubEntries,
  loadExternalManifest,
  buildLocalHubEntry,
  readRequiredSkillshareTags,
  buildLocalSkillSource,
  validateHubEntry,
  normalizeHubEntry,
  buildRootHubDocument,
  canMergeRootEntries,
  mergeRootEntries,
  isExplicitHubSource,
  sortHubEntries,
  serializeJson,
  checkGeneratedHubFiles,
  listExistingHubFiles,
  DEFAULT_LOCAL_SOURCE_PATH,
};

function isCliEntrypoint() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isCliEntrypoint()) {
  main().catch((error) => {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  });
}
