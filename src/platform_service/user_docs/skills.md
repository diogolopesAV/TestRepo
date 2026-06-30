---
route: /platform/skills
title: Skills Registry aaa
description: Browse, create, and manage reusable AI capabilities across Riverty.
updatedAt: 2026-06-29
version: "1.0"
---

The Skills Registry is where Riverty's reusable AI capabilities live — every skill is version-controlled in GitHub, owned by a named team, and ready to drop into your workflow.

## What is a Skill?

A Skill is a small, named recipe that tells an AI assistant how to do one specific job, the way your team does it. It is not the AI model itself, and it is not a chatbot. Think of it as the instructions a senior colleague would write for a new joiner: "When someone asks you to draft a PRD, use this template, ask these questions first, and never skip the success metrics section."

In practice, a Skill is a folder containing a file called `SKILL.md`. That file has a name, a one-line description of when to use it, and written instructions — the steps, examples, and do/don't rules a human would write down. When the AI is asked to do that kind of work, it reads the matching Skill first. Same underlying model, but it now behaves like someone who has been doing that job at your company for years.

The `SKILL.md` format is an open standard originally from Anthropic and reused across public skill catalogs. Riverty adopted it so our work travels with the wider industry and survives a change of model or vendor.

### Skills in the Riverty Platform

On the platform, Skills are not just documents — they are living, governed assets:

- **Stored in GitHub** — one folder per Skill, in the skills repository. The platform reads them directly; there is no hidden database.
- **Owned by a steward team** — every Skill has a team accountable for it (Finance Operations, Marketing, Architecture Guild, Product Management, …). When a Skill misbehaves, you know who to contact.
- **Searchable in one place** — grouped by area (Finance, Product, Engineering, …) and filterable by complexity (beginner / intermediate / advanced) and tags.
- **Editable through Skill Studio** — a guided form in the UI. Fill in the description and instructions, click Save, and the platform opens a pull request on your behalf. No git knowledge required.
- **Composable building blocks** — Skills can be grouped into Bundles and orchestrated by Agents. One well-written Skill lifts many downstream products and workflows.

### Skill statuses

Every Skill moves through a defined lifecycle so you always know what is safe to rely on.

| Status | Meaning |
|---|---|
| **Draft** | Under development. Not yet available to consumers. |
| **Active** | Published and reviewed. Safe to use in production workflows. |
| **Deprecated** | Retained for reference but not recommended for new use. |

### How skills are stored and governed

The deliberate choice: a Skill is just a Markdown file in Git. It is reviewed, versioned, rolled back, and audited like any other piece of code. Every change goes through a pull request. A designated steward team reviews and merges it. The history is permanent.

## Using Skills

You do not need to be a developer to use a Skill. The Skills page gives you a searchable catalogue and a way to run any Skill directly from your browser, without touching the command line.

### Finding a Skill

Use the search bar and filters at the top of the registry. Filter by area (Finance, Product, Engineering), complexity level, or tags. Each card shows the Skill name, its one-line description, the steward team, and current status. Click a card to see the full detail, including the inputs it expects and example outputs.

### Requesting access

Some Skills are restricted to specific teams. If you see a **Request access** button, click it. Your request goes to the steward team listed on the Skill card. They will approve and, if the Skill depends on a particular tool or package (e.g. `@riverty/web-components` for the Web Accessibility Reviewer), they will confirm you have that dependency in place.

### Running a Skill stand-alone

Open the **Experiment** scratchpad from the sidebar, select the Skill you want, provide the inputs it asks for (a snippet of code, a description, a document), and submit. Results stream back directly in the interface. Stand-alone runs are not logged to production analytics, so they are safe to use while exploring or testing.

### Using Skills inside a Bundle

A Bundle groups related Skills and wires them together with the tools they need. Installing a Bundle (e.g. the Riverty Web Frontend Bundle) gives you the Web Accessibility Reviewer, Design Tokens Usage, and the Riverty component library in one step. A single prompt can then scaffold a token-correct, accessible component end-to-end — because all the Skills are cooperating through the same agent session.

## Skill Examples

These three Skills are live in the registry today and cover a range of personas — from UI engineers to cloud platform teams. Each entry explains why you would reach for it, what it actually does, and how to get started.

### Web Accessibility Reviewer

**Stewarded by:** Design System Guild. Also used by the Frontend Chapter and packaged into the Riverty Web Frontend Bundle.

**Who needs it:** Any frontend developer or accessibility champion who reviews components for WCAG compliance. Every new feature carries a small audit: did we set the `lang` attribute, are buttons keyboard-reachable, does the contrast pass AA, did we use `<r-button>` or fall back to a raw `<button>`? The Skill front-loads those checks so reviewers do not chase them in PR comments. One reviewer reported cutting their accessibility review time roughly in half. Note: the Skill covers web only — it will politely decline to review React Native components.

**What it does:** Given a component description, an HTML/SCSS snippet, or a full page, it checks `package.json` for `@riverty/web-components` and decides whether to use `<r-button>`, `<r-input>`, etc. or fall back to accessible native HTML. It applies the full WCAG 2.1/2.2 AA checklist in order, runs a contrast check against the actual colors in your CSS (not just the token names), and explains every change so you can defend it in review.

**To use it:** Search "Web Accessibility" on the Skills page. Request access from the Design System Guild if needed. Run it stand-alone in the Experiment scratchpad (paste your HTML/SCSS or describe the component) or install the Riverty Web Frontend Bundle to get it bundled with Design Tokens Usage and the component library.

### CDN Classic to Front Door Migration

**Stewarded by:** Cloud Platform Guild. Also used by the BIP team and packaged into the Azure Platform Bundle.

**Who needs it:** Platform and cloud engineers migrating Azure CDN Classic to Azure Front Door. The Azure Portal handles the migration in a few clicks — but then leaves your Terraform repo describing resources that no longer exist. Rewriting the HCL, removing classic state, and importing resources in the right order without accidentally running `terraform apply` against what the Portal just deleted is the part that takes a careful afternoon. The Skill turns that afternoon into a guided sequence. Note: if Portal-migrated resource names drift between environments, you still have to discover them yourself — the Skill will not guess at names.

**What it does:** Given a Terraform repository that previously managed `azurerm_cdn_profile` / `azurerm_cdn_endpoint`, it discovers the AFD resources the Portal has already created, rewrites the HCL using the BIP `cdn_frontdoor_profile` / `cdn_frontdoor_endpoint` modules, walks the `terraform state rm` + `terraform import` sequence in dependency order, adds a migration lock so test runs before live, and categorises the plan output so you can see which diffs are expected versus which mean "stop, you missed an import."

**To use it:** Search "CDN Classic Migration" on the Skills page. Request access from the Cloud Platform Guild if needed — they will confirm you are on `azurerm >= 4.x` and Terraform >= 1.9. Run it stand-alone by pointing it at your repo and environment in the Experiment scratchpad, or install the Azure Platform Bundle to get the Skill, BIP module references, and the Azure MCP wired up together.

### Design Tokens Usage

**Stewarded by:** Design System Guild. Also used by the Frontend Chapter and packaged into the Riverty Web Frontend Bundle.

**Who needs it:** UI engineers and designers who code with AI. Picking the right token is half "which color is this?" and half "is this even a semantic token or am I about to commit a legacy one we are trying to retire?" Multiplied by spacing, typography, icon sizes, and theme switching, it adds up. The Skill resolves a request like "primary CTA on the dark theme" to a specific CSS Custom Property and is honest when the answer is "there is no semantic token for this yet — use this base token as a temporary bridge and raise it with the design system team." Note: the Skill deliberately will not recommend `@riverty/css-framework` utility classes, even when one would be shorter — by design.

**What it does:** Given a styling intent ("muted background for a card on dark theme") or an existing CSS/SCSS snippet, it looks up the correct token in `@riverty/design-tokens`, prefers semantic over base over legacy, emits the CSS Custom Property reference (e.g. `var(--r-color-surface-subtle)`), handles theming via the `data-theme` attribute, and detects deprecated or renamed tokens in existing code, proposing the migration target. When no good semantic token exists, it says so explicitly.

**To use it:** Search "Design Tokens Usage" on the Skills page. Request access from the Design System Guild if needed — they will confirm `@riverty/design-tokens` is installed at a version matching the token catalog the Skill references. Run it stand-alone in the Experiment scratchpad or install the Riverty Web Frontend Bundle to get it alongside Web Accessibility and the Riverty component library.

## Building Skills

Skills are created through the Skill Studio — a guided form that opens a pull request for you. No git knowledge is required to get started. For developers who want to work directly with `SKILL.md`, everything you need is below.

### Creating a Skill

Click **New Skill** in the top-right corner of the registry. Name the Skill, write a one-line description, define what inputs it expects, and write the instructions the AI should follow. Click **Save** and the platform opens a pull request in the skills repository on your behalf. The designated steward team reviews and merges it.

### The SKILL.md format

`SKILL.md` is a Markdown file with YAML front-matter. The front-matter declares structured metadata (name, version, description, inputs, outputs, tools, model, tags). The Markdown body is the system prompt — the instructions the AI reads before it does any work. Required front-matter fields: `name`, `version`, `description`, `inputs`, `outputs`.

### Review, versioning, and deprecation

Every new Skill or update goes through a pull request reviewed by the steward team. Skills use semantic versioning (`MAJOR.MINOR.PATCH`): patch for wording tweaks with no schema changes, minor for new optional inputs or outputs, major for breaking changes that consumers must migrate to. To deprecate a Skill, update its status field in `SKILL.md` and open a PR. Skills are never deleted — they are deprecated to preserve audit history.
