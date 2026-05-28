#!/usr/bin/env node

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertUniqueSkillNames,
  discoverRepoSkills,
  parseFrontmatter,
} from "./lib/skills-repo.js";

const DEFAULT_CONFIG_PATH = "confluence-sync.config.json";
const DEFAULT_BASE_URL = "https://riverty.atlassian.net";
const DEFAULT_PAGE_TITLE_PREFIX = "Skill: ";
const DEFAULT_SKILLS_ROOT = "skills";
const DEFAULT_REPO_URL = "https://github.com/Riverty-Tech-Innovation/skills";
const MAX_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 500;
const MAX_VERSION_CONFLICT_RETRIES = 3;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const repoRoot = process.cwd();
  const configPath = path.resolve(repoRoot, args.configPath || DEFAULT_CONFIG_PATH);
  const config = await loadConfig(configPath, Boolean(args.configPath));

  const settings = resolveSettings({
    args,
    config,
    env: process.env,
    repoRoot,
  });

  validateSettings(settings);

  const email = process.env.ATLASSIAN_EMAIL;
  const apiToken = process.env.ATLASSIAN_API_TOKEN;
  if (!email || !apiToken) {
    throw new Error(
      "Missing credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN."
    );
  }

  const dryRun = !args.apply;
  const client = new ConfluenceClient({
    baseUrl: settings.baseUrl,
    email,
    apiToken,
    verbose: settings.verbose,
  });

  const skills = await discoverSkills({
    repoRoot,
    skillsRoot: settings.skillsRoot,
    repoUrl: settings.repoUrl,
    pageTitlePrefix: settings.pageTitlePrefix,
  });

  if (skills.length === 0) {
    throw new Error(
      `No skills found under "${settings.skillsRoot}" using supported layouts ` +
        `${settings.skillsRoot}/*/SKILL.md and ${settings.skillsRoot}/*/*/SKILL.md.`
    );
  }

  const parentPage = await client.getPage(settings.parentPageId);
  const existingChildPages = await client.listChildPages(settings.parentPageId);
  const plan = buildPlan({
    skills,
    existingChildPages,
    pageTitlePrefix: settings.pageTitlePrefix,
    deleteMissing: settings.deleteMissing,
  });

  logPlan({
    plan,
    dryRun,
    parentPageId: settings.parentPageId,
    parentTitle: parentPage.title,
  });

  if (dryRun) {
    printSummary(plan, "Dry-run summary");
    return;
  }

  await applyPlan({
    plan,
    client,
    parentPageId: settings.parentPageId,
    parentSpaceKey: parentPage.space?.key,
  });

  printSummary(plan, "Apply summary");
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: false,
    verbose: false,
    help: false,
    configPath: null,
    parentPageId: null,
    skillsRoot: null,
    repoUrl: null,
    baseUrl: null,
    deleteMissing: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (token === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token.startsWith("--config=")) {
      args.configPath = token.slice("--config=".length);
      continue;
    }
    if (token === "--config") {
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        throw new Error("Missing value for --config option");
      }
      args.configPath = next;
      i += 1;
      continue;
    }

    if (token.startsWith("--parent-page-id=")) {
      args.parentPageId = token.slice("--parent-page-id=".length);
      continue;
    }
    if (token === "--parent-page-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--parent-page-id flag requires a non-empty value argument");
      }
      args.parentPageId = value;
      i += 1;
      continue;
    }

    if (token.startsWith("--skills-root=")) {
      args.skillsRoot = token.slice("--skills-root=".length);
      continue;
    }
    if (token === "--skills-root") {
      const nextToken = argv[i + 1];
      if (!nextToken || nextToken.startsWith("--")) {
        throw new Error('Missing value for --skills-root. Provide a path, e.g. "--skills-root skills".');
      }
      args.skillsRoot = nextToken;
      i += 1;
      continue;
    }

    if (token.startsWith("--repo-url=")) {
      args.repoUrl = token.slice("--repo-url=".length);
      continue;
    }
    if (token === "--repo-url") {
      const nextToken = argv[i + 1];
      if (!nextToken || nextToken.startsWith("--")) {
        throw new Error("Missing value for --repo-url");
      }
      args.repoUrl = nextToken;
      i += 1;
      continue;
    }

    if (token.startsWith("--base-url=")) {
      args.baseUrl = token.slice("--base-url=".length);
      continue;
    }
    if (token === "--base-url") {
      const nextToken = argv[i + 1];
      if (!nextToken || nextToken.startsWith("--")) {
        throw new Error("Missing value for --base-url; expected a URL after the flag.");
      }
      args.baseUrl = nextToken;
      i += 1;
      continue;
    }

    if (token === "--delete-missing") {
      args.deleteMissing = true;
      continue;
    }
    if (token === "--no-delete-missing" || token === "--no-delete") {
      args.deleteMissing = false;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.apply && args.dryRun) {
    throw new Error("Use either --apply or --dry-run, not both.");
  }

  return args;
}

async function loadConfig(configPath, strict) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT" && !strict) {
      return {};
    }
    if (error.code === "ENOENT" && strict) {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw new Error(`Failed to read config file ${configPath}: ${error.message}`);
  }
}

function resolveSettings({ args, config, env, repoRoot }) {
  const baseUrl =
    args.baseUrl || env.ATLASSIAN_BASE_URL || config.baseUrl || DEFAULT_BASE_URL;
  const configuredPageTitlePrefix =
    config.pageTitlePrefix === undefined || config.pageTitlePrefix === null
      ? DEFAULT_PAGE_TITLE_PREFIX
      : String(config.pageTitlePrefix);
  const configuredDeleteMissing =
    typeof config.deleteMissing === "boolean" ? config.deleteMissing : false;

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    parentPageId: String(args.parentPageId || config.parentPageId || "").trim(),
    skillsRoot: String(args.skillsRoot || config.skillsRoot || DEFAULT_SKILLS_ROOT),
    pageTitlePrefix: configuredPageTitlePrefix,
    deleteMissing:
      args.deleteMissing === null ? configuredDeleteMissing : args.deleteMissing,
    repoUrl: String(args.repoUrl || config.repoUrl || DEFAULT_REPO_URL),
    verbose: args.verbose,
    repoRoot,
  };
}

function validateSettings(settings) {
  if (!settings.parentPageId) {
    throw new Error(
      "Missing parentPageId. Set it in config or provide --parent-page-id."
    );
  }

  if (!settings.pageTitlePrefix) {
    throw new Error("pageTitlePrefix must not be empty.");
  }

  if (!isValidHttpUrl(settings.baseUrl)) {
    throw new Error(
      `Invalid baseUrl "${settings.baseUrl}". Provide a valid http(s) URL.`
    );
  }

  if (!isValidHttpUrl(settings.repoUrl)) {
    throw new Error(
      `Invalid repoUrl "${settings.repoUrl}". Provide a valid http(s) URL.`
    );
  }
}

async function discoverSkills({
  repoRoot,
  skillsRoot,
  repoUrl,
  pageTitlePrefix,
}) {
  const discoveredSkills = await discoverRepoSkills({
    repoRoot,
    skillsRoot,
  });

  assertUniqueSkillNames(discoveredSkills);

  const skills = [];
  for (const discoveredSkill of discoveredSkills) {
    const {
      description: skillDescription,
      name: skillName,
      skillDirAbs,
      skillDirRel,
      skillMdRaw,
      skillMdRel,
    } = discoveredSkill;
    const referencesAbs = path.join(skillDirAbs, "references");
    const references = [];
    const referenceEntries = await safeReadDir(referencesAbs);
    for (const refEntry of referenceEntries) {
      if (!refEntry.isFile() || !refEntry.name.endsWith(".md")) {
        continue;
      }
      const refAbs = path.join(referencesAbs, refEntry.name);
      const refRel = toPosix(path.relative(repoRoot, refAbs));
      references.push({
        pathRel: refRel,
        content: await fs.readFile(refAbs, "utf8"),
      });
    }
    references.sort((a, b) => a.pathRel.localeCompare(b.pathRel));

    const allFiles = await listFilesRecursive(skillDirAbs);
    const allFileRels = allFiles
      .map((fileAbs) => toPosix(path.relative(repoRoot, fileAbs)))
      .sort((a, b) => a.localeCompare(b));

    const syncedSet = new Set([skillMdRel, ...references.map((ref) => ref.pathRel)]);
    const nonSyncedFiles = allFileRels.filter(
      (file) => !syncedSet.has(file) && !isIgnoredFile(file)
    );

    const checksum = buildChecksum({
      skillName,
      skillDescription,
      skillDirRel,
      skillMdRaw,
      references,
    });

    const pageTitle = `${pageTitlePrefix}${skillName}`;
    const pageHtml = buildPageStorageHtml({
      skillName,
      skillDescription,
      skillDirRel,
      skillMdRel,
      skillMdRaw,
      references,
      nonSyncedFiles,
      checksum,
      repoUrl,
    });

    skills.push({
      skillName,
      pageTitle,
      sourcePath: skillDirRel,
      checksum,
      html: pageHtml,
    });
  }

  skills.sort((a, b) => a.pageTitle.localeCompare(b.pageTitle));
  return skills;
}

function buildChecksum(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")}`;
}

function buildPageStorageHtml({
  skillName,
  skillDescription,
  skillDirRel,
  skillMdRel,
  skillMdRaw,
  references,
  nonSyncedFiles,
  checksum,
  repoUrl,
}) {
  const timestamp = new Date().toISOString();
  const sourceUrl = joinUrl(repoUrl, `tree/main/${skillDirRel}`);

  const metadataSection = [
    "<h2>Sync Metadata</h2>",
    "<ul>",
    `<li><strong>Generated at (UTC):</strong> <code>${escapeHtml(timestamp)}</code></li>`,
    `<li><strong>Source path:</strong> <code>${escapeHtml(skillDirRel)}</code></li>`,
    `<li><strong>Source URL:</strong> <a href="${escapeHtml(sourceUrl)}">${escapeHtml(
      sourceUrl
    )}</a></li>`,
    `<li><strong>Mirror checksum:</strong> <code>${escapeHtml(checksum)}</code></li>`,
    "</ul>",
  ].join("\n");

  const skillMetadataSection = [
    "<h2>Skill Metadata</h2>",
    "<table>",
    "  <tbody>",
    "    <tr><th>Name</th><td>" + escapeHtml(skillName) + "</td></tr>",
    "    <tr><th>Description</th><td>" + escapeHtml(skillDescription || "(none)") + "</td></tr>",
    "    <tr><th>Primary file</th><td><code>" + escapeHtml(skillMdRel) + "</code></td></tr>",
    "  </tbody>",
    "</table>",
  ].join("\n");

  const skillMdSection = [
    "<h2>SKILL.md</h2>",
    `<p><em>Source: <code>${escapeHtml(skillMdRel)}</code></em></p>`,
    markdownToConfluenceCodeBlock(skillMdRaw),
  ].join("\n");

  const referenceSection = [
    "<h2>References</h2>",
    references.length === 0 ? "<p>No markdown reference files found.</p>" : "",
    ...references.map((ref) => {
      return [
        `<h3>${escapeHtml(path.basename(ref.pathRel))}</h3>`,
        `<p><em>Source: <code>${escapeHtml(ref.pathRel)}</code></em></p>`,
        markdownToConfluenceCodeBlock(ref.content),
      ].join("\n");
    }),
  ].join("\n");

  const nonSyncedSection = [
    "<h2>Non-synced Files</h2>",
    "<p>These files exist in the skill directory but are not mirrored in page content.</p>",
    nonSyncedFiles.length === 0
      ? "<p><em>None</em></p>"
      : `<ul>${nonSyncedFiles
          .map((file) => `<li><code>${escapeHtml(file)}</code></li>`)
          .join("")}</ul>`,
  ].join("\n");

  return [
    "<h1>Skill Mirror</h1>",
    metadataSection,
    skillMetadataSection,
    skillMdSection,
    referenceSection,
    nonSyncedSection,
  ].join("\n\n");
}

function buildPlan({
  skills,
  existingChildPages,
  pageTitlePrefix,
  deleteMissing,
}) {
  const existingByTitle = new Map(
    existingChildPages.map((page) => [page.title, page])
  );
  const desiredTitles = new Set(skills.map((skill) => skill.pageTitle));

  const toCreate = [];
  const toUpdate = [];
  const unchanged = [];
  const toDelete = [];

  for (const skill of skills) {
    const existing = existingByTitle.get(skill.pageTitle);
    if (!existing) {
      toCreate.push(skill);
      continue;
    }

    const existingChecksum = extractChecksum(existing.body?.storage?.value || "");
    if (existingChecksum === skill.checksum) {
      unchanged.push({
        title: skill.pageTitle,
        id: existing.id,
      });
      continue;
    }

    toUpdate.push({
      id: existing.id,
      title: skill.pageTitle,
      version: existing.version?.number || 1,
      html: skill.html,
      checksum: skill.checksum,
    });
  }

  if (deleteMissing) {
    for (const page of existingChildPages) {
      if (!page.title.startsWith(pageTitlePrefix)) {
        continue;
      }
      if (desiredTitles.has(page.title)) {
        continue;
      }
      toDelete.push({
        id: page.id,
        title: page.title,
      });
    }
  }

  return {
    toCreate,
    toUpdate,
    unchanged,
    toDelete,
  };
}

async function applyPlan({
  plan,
  client,
  parentPageId,
  parentSpaceKey,
}) {
  if (plan.toCreate.length > 0 && !parentSpaceKey) {
    throw new Error(
      "Parent page space key is missing. Cannot create child pages without space metadata."
    );
  }

  for (const createOp of plan.toCreate) {
    await client.createPage({
      parentPageId,
      spaceKey: parentSpaceKey,
      title: createOp.pageTitle,
      html: createOp.html,
    });
    console.log(`[APPLY] CREATED: ${createOp.pageTitle}`);
  }

  for (const updateOp of plan.toUpdate) {
    await client.updatePage({
      pageId: updateOp.id,
      title: updateOp.title,
      html: updateOp.html,
      versionNumber: updateOp.version,
    });
    console.log(`[APPLY] UPDATED: ${updateOp.title}`);
  }

  for (const deleteOp of plan.toDelete) {
    await client.deletePage(deleteOp.id);
    console.log(`[APPLY] DELETED: ${deleteOp.title}`);
  }
}

function logPlan({ plan, dryRun, parentPageId, parentTitle }) {
  console.log(
    `[INFO] Target parent page: ${parentPageId} (${parentTitle || "unknown title"})`
  );
  console.log(`[INFO] Mode: ${dryRun ? "dry-run" : "apply"}`);

  for (const entry of plan.toCreate) {
    console.log(`[PLAN] CREATE: ${entry.pageTitle}`);
  }
  for (const entry of plan.toUpdate) {
    console.log(`[PLAN] UPDATE: ${entry.title}`);
  }
  for (const entry of plan.toDelete) {
    console.log(`[PLAN] DELETE: ${entry.title}`);
  }
  for (const entry of plan.unchanged) {
    console.log(`[PLAN] UNCHANGED: ${entry.title}`);
  }
}

function printSummary(plan, label) {
  console.log(`\n${label}`);
  console.log(`- create: ${plan.toCreate.length}`);
  console.log(`- update: ${plan.toUpdate.length}`);
  console.log(`- delete: ${plan.toDelete.length}`);
  console.log(`- unchanged: ${plan.unchanged.length}`);
}

function printUsage() {
  console.log(`Usage:
  node scripts/sync-confluence-skills.js --dry-run
  node scripts/sync-confluence-skills.js --apply

Options:
  --config <path>            Path to config JSON file
  --parent-page-id <id>      Override parent page id
  --skills-root <path>       Override skills root folder (default: skills)
  --repo-url <url>           Override repository URL used in page metadata
  --base-url <url>           Override Confluence base URL
  --delete-missing           Delete Confluence child pages missing in local skills
  --no-delete-missing        Do not delete missing pages (alias: --no-delete)
  --verbose                  Enable verbose HTTP logs
  --help, -h                 Show this help

Environment variables:
  ATLASSIAN_EMAIL            Atlassian account email
  ATLASSIAN_API_TOKEN        Atlassian API token
  ATLASSIAN_BASE_URL         Optional base URL override
`);
}

function extractChecksum(storageHtml) {
  const checksumMatch = storageHtml.match(/sha256:[a-f0-9]{64}/i);
  return checksumMatch ? checksumMatch[0].toLowerCase() : null;
}

function markdownToConfluenceCodeBlock(markdown) {
  const cdataSafeContent = String(markdown).replaceAll("]]>", "]]]]><![CDATA[>");
  return [
    '<ac:structured-macro ac:name="code" ac:schema-version="1">',
    '<ac:parameter ac:name="language">markdown</ac:parameter>',
    `<ac:plain-text-body><![CDATA[${cdataSafeContent}]]></ac:plain-text-body>`,
    "</ac:structured-macro>",
  ].join("\n");
}

class ConfluenceRequestError extends Error {
  constructor(
    message,
    { status, statusText, responseBody, operationName } = {}
  ) {
    super(message);
    this.name = "ConfluenceRequestError";
    this.status = status;
    this.statusText = statusText;
    this.responseBody = responseBody;
    this.operationName = operationName;
  }
}

class ConfluenceClient {
  constructor({ baseUrl, email, apiToken, verbose, fetchImpl = fetch, sleep = delay }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.verbose = verbose;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async getPage(pageId) {
    return this.request({
      method: "GET",
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      query: { expand: "space" },
      operationName: `fetch page ${pageId}`,
    });
  }

  async listChildPages(parentPageId) {
    const pages = [];
    let start = 0;
    const limit = 100;

    while (true) {
      const response = await this.request({
        method: "GET",
        path: `/wiki/rest/api/content/${encodeURIComponent(parentPageId)}/child/page`,
        query: {
          start: String(start),
          limit: String(limit),
          expand: "version,body.storage,space",
        },
        operationName: `list child pages of ${parentPageId}`,
      });

      const results = response.results || [];
      pages.push(...results);
      const nextLink = response._links?.next;
      if (!nextLink) {
        break;
      }

      const nextUrl = new URL(nextLink, this.baseUrl);
      const nextStart = Number(nextUrl.searchParams.get("start"));
      start =
        Number.isFinite(nextStart) && nextStart >= 0
          ? nextStart
          : start + results.length;
    }

    return pages;
  }

  async createPage({ parentPageId, spaceKey, title, html }) {
    return this.request({
      method: "POST",
      path: "/wiki/rest/api/content",
      body: {
        type: "page",
        title,
        space: { key: spaceKey },
        ancestors: [{ id: String(parentPageId) }],
        body: {
          storage: {
            value: html,
            representation: "storage",
          },
        },
      },
      operationName: `create page ${title}`,
    });
  }

  async updatePage({ pageId, title, html, versionNumber }) {
    let currentVersion = Number(versionNumber);
    if (!Number.isFinite(currentVersion) || currentVersion < 1) {
      currentVersion = await this.getPageVersion(pageId);
    }

    for (let attempt = 0; attempt < MAX_VERSION_CONFLICT_RETRIES; attempt += 1) {
      try {
        return await this.request({
          method: "PUT",
          path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
          body: {
            id: String(pageId),
            type: "page",
            title,
            version: {
              number: Number(currentVersion) + 1,
              message: "Synced from skills repository",
            },
            body: {
              storage: {
                value: html,
                representation: "storage",
              },
            },
          },
          operationName: `update page ${title}`,
        });
      } catch (error) {
        const isConflict = error instanceof ConfluenceRequestError && error.status === 409;
        if (!isConflict || attempt === MAX_VERSION_CONFLICT_RETRIES - 1) {
          throw error;
        }

        currentVersion = await this.getPageVersion(pageId);
        if (this.verbose) {
          console.log(
            `[DEBUG] Version conflict updating ${title}; retrying with version ${currentVersion}`
          );
        }
      }
    }
  }

  async getPageVersion(pageId) {
    const page = await this.request({
      method: "GET",
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      query: { expand: "version" },
      operationName: `fetch version for page ${pageId}`,
    });
    const version = Number(page?.version?.number);
    if (!Number.isFinite(version) || version < 1) {
      throw new Error(`Could not determine current version for page ${pageId}.`);
    }
    return version;
  }

  async deletePage(pageId) {
    return this.request({
      method: "DELETE",
      path: `/wiki/rest/api/content/${encodeURIComponent(pageId)}`,
      operationName: `delete page ${pageId}`,
    });
  }

  async request({
    method,
    path: requestPath,
    query,
    body,
    operationName,
  }) {
    const url = new URL(requestPath, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      }
    }

    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (this.verbose) {
        console.log(`[DEBUG] ${method} ${url.toString()} (attempt ${attempt + 1})`);
      }

      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (error) {
        if (attempt < MAX_RETRIES - 1) {
          await this.sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
          continue;
        }
        throw new Error(`${operationName} failed: ${error.message}`);
      }

      const shouldRetry =
        response.status === 429 || response.status >= 500;
      if (shouldRetry && attempt < MAX_RETRIES - 1) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = Number(retryAfterHeader);
        const delayMs =
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : RETRY_BASE_DELAY_MS * 2 ** attempt;
        await this.sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        const errorText = await safeReadText(response);
        throw new ConfluenceRequestError(
          `${operationName} failed with ${response.status} ${response.statusText}: ${errorText}`,
          {
            status: response.status,
            statusText: response.statusText,
            responseBody: errorText,
            operationName,
          }
        );
      }

      if (response.status === 204) {
        return null;
      }

      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        return response.json();
      }

      return safeReadText(response);
    }

    /* c8 ignore next 2 */
    throw new Error(`${operationName} failed after ${MAX_RETRIES} attempts`);
  }
}

const IGNORED_FILE_PATTERNS = [/(?:^|\/)\.DS_Store$/, /(?:^|\/)Thumbs\.db$/];

function isIgnoredFile(filePath) {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}

async function listFilesRecursive(rootDirAbs) {
  const files = [];

  async function walk(currentDir) {
    const entries = await safeReadDir(currentDir);
    for (const entry of entries) {
      const entryAbs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryAbs);
        continue;
      }
      if (entry.isFile()) {
        files.push(entryAbs);
      }
    }
  }

  await walk(rootDirAbs);
  return files;
}

async function safeReadDir(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function ensureDirectoryExists(dirPath, label) {
  let stat;
  try {
    stat = await fs.stat(dirPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} directory does not exist: ${dirPath}`);
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

function escapeHtml(input) {
  return String(input)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function joinUrl(base, suffix) {
  return `${String(base).replace(/\/+$/, "")}/${String(suffix).replace(/^\/+/, "")}`;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "(failed to parse response body)";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const _test = {
  parseArgs,
  loadConfig,
  resolveSettings,
  validateSettings,
  discoverSkills,
  buildChecksum,
  buildPageStorageHtml,
  applyPlan,
  logPlan,
  printSummary,
  parseFrontmatter,
  markdownToConfluenceCodeBlock,
  buildPlan,
  extractChecksum,
  listFilesRecursive,
  isIgnoredFile,
  safeReadDir,
  fileExists,
  ensureDirectoryExists,
  escapeHtml,
  normalizeBaseUrl,
  isValidHttpUrl,
  toPosix,
  joinUrl,
  safeReadText,
  delay,
  ConfluenceClient,
  ConfluenceRequestError,
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
