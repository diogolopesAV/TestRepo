import { promises as fs } from "node:fs";
import path from "node:path";

export const GENERAL_HUB_NAME = "general";

export async function discoverRepoSkills({ repoRoot, skillsRoot }) {
  const skillsRootAbs = path.resolve(repoRoot, skillsRoot);
  await ensureDirectoryExists(skillsRootAbs, "skillsRoot");

  const rootEntries = sortDirEntries(await safeReadDir(skillsRootAbs));
  const skills = [];

  for (const rootEntry of rootEntries) {
    if (!rootEntry.isDirectory()) {
      continue;
    }

    const rootEntryAbs = path.join(skillsRootAbs, rootEntry.name);
    const rootSkillMdAbs = path.join(rootEntryAbs, "SKILL.md");

    if (await fileExists(rootSkillMdAbs)) {
      skills.push(
        await loadSkillRecord({
          repoRoot,
          groupName: null,
          skillDirAbs: rootEntryAbs,
          directoryName: rootEntry.name,
        })
      );
      continue;
    }

    const childEntries = sortDirEntries(await safeReadDir(rootEntryAbs));
    for (const childEntry of childEntries) {
      if (!childEntry.isDirectory()) {
        continue;
      }

      const skillDirAbs = path.join(rootEntryAbs, childEntry.name);
      const skillMdAbs = path.join(skillDirAbs, "SKILL.md");
      if (!(await fileExists(skillMdAbs))) {
        continue;
      }

      skills.push(
        await loadSkillRecord({
          repoRoot,
          groupName: rootEntry.name,
          skillDirAbs,
          directoryName: childEntry.name,
        })
      );
    }
  }

  skills.sort((left, right) => left.skillDirRel.localeCompare(right.skillDirRel));
  return skills;
}

export function assertUniqueSkillNames(skills) {
  const seenNames = new Set();

  for (const skill of skills) {
    if (seenNames.has(skill.name)) {
      throw new Error(`Duplicate skill name found in frontmatter: ${skill.name}`);
    }
    seenNames.add(skill.name);
  }
}

export function parseFrontmatter(markdownText, { sourceLabel = "unknown source" } = {}) {
  const normalized = markdownText.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return {};
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    console.warn(
      `[WARN] Frontmatter in ${sourceLabel} is malformed (missing closing ---).`
    );
    return {};
  }

  const frontmatterBlock = normalized.slice(4, closingIndex);
  const lines = frontmatterBlock.split("\n");
  const data = {};
  let hasUnsupportedYaml = false;
  let insideMetadataBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (/^\s/.test(line)) {
      if (!insideMetadataBlock) {
        hasUnsupportedYaml = true;
        continue;
      }

      const nestedMatch = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!nestedMatch) {
        hasUnsupportedYaml = true;
        continue;
      }

      data.metadata[nestedMatch[1]] = parseYamlScalar(nestedMatch[2].trim());
      continue;
    }

    insideMetadataBlock = false;

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      hasUnsupportedYaml = true;
      continue;
    }

    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue === "|" || rawValue === ">") {
      hasUnsupportedYaml = true;
      continue;
    }

    if (key === "metadata" && rawValue === "") {
      data.metadata = {};
      insideMetadataBlock = true;
      continue;
    }

    data[key] = parseYamlScalar(rawValue);
  }

  if (hasUnsupportedYaml) {
    console.warn(
      `[WARN] Frontmatter in ${sourceLabel} contains unsupported YAML constructs. ` +
        "Only top-level single-line key: value entries and metadata.* scalars are parsed."
    );
  }

  if (!Object.hasOwn(data, "name")) {
    console.warn(
      `[WARN] Frontmatter in ${sourceLabel} does not define "name". ` +
        "The skill directory name will be used as fallback."
    );
  }

  return {
    name: typeof data.name === "string" ? data.name : "",
    description: typeof data.description === "string" ? data.description : "",
    metadata: isPlainObject(data.metadata) ? data.metadata : {},
  };
}

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function loadSkillRecord({
  repoRoot,
  groupName,
  skillDirAbs,
  directoryName,
}) {
  const skillMdAbs = path.join(skillDirAbs, "SKILL.md");
  const skillMdRel = toPosix(path.relative(repoRoot, skillMdAbs));
  const skillDirRel = toPosix(path.relative(repoRoot, skillDirAbs));
  const skillMdRaw = await fs.readFile(skillMdAbs, "utf8");
  const frontmatter = parseFrontmatter(skillMdRaw, {
    sourceLabel: skillMdRel,
  });

  return {
    groupName,
    hubName: groupName || GENERAL_HUB_NAME,
    directoryName,
    name: frontmatter.name || directoryName,
    description: frontmatter.description || "",
    metadata: frontmatter.metadata || {},
    isInternal: frontmatter.metadata?.internal === true,
    skillDirAbs,
    skillDirRel,
    skillMdAbs,
    skillMdRel,
    skillMdRaw,
  };
}

function parseYamlScalar(rawValue) {
  const value = stripYamlQuotes(rawValue);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function stripYamlQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function ensureDirectoryExists(dirAbs, label) {
  try {
    const stat = await fs.stat(dirAbs);
    if (!stat.isDirectory()) {
      throw new Error(`${label} is not a directory: ${dirAbs}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} directory not found: ${dirAbs}`);
    }
    throw new Error(`Failed to access ${label} ${dirAbs}: ${error.message}`);
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

function sortDirEntries(entries) {
  return [...entries].sort((left, right) => left.name.localeCompare(right.name));
}
