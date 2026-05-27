---
name: mock-validation-skill
description: A comprehensive mock skill designed to validate the Python backend's PyYAML frontmatter extraction and markdown parsing logic.
complexity: advanced
time_to_learn: 15 minute
license: MIT
allowed-tools:
  - read_file
  - grep_search
  - run_terminal_command
metadata:
  version: 1.0.0
  skillshare-tags: testing, validation, backend
---

# Mock Validation Skill

A comprehensive mock skill designed to validate the Python backend's PyYAML frontmatter extraction and markdown parsing logic.

## When to Use

Use this skill when:
- You are testing the `skills_catalog.py` parsing logic.
- You want to ensure multiline YAML arrays (like `allowed-tools`) and nested dictionaries (like `metadata`) are correctly converted into Python dictionaries without string-splitting errors.
- You need to verify that `complexity: advanced` correctly maps to `tier: 3` in the API response.

## Core Workflow

### Step 1: Verify Frontmatter Extraction
The backend should extract the YAML block between the `---` lines. Check your API response to ensure `timeToLearn`, `license`, and `allowedTools` are populated with these exact values, rather than showing up as `null`.

### Step 2: Verify Markdown Body
This text below the second `---` is standard Markdown. It should be entirely ignored by the PyYAML parser and safely passed along as the raw `body` string.
