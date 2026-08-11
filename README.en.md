# NL Skills

A collection of AI Agent Skills with clear, executable workflows for common tasks.

[中文](README.md)

## Available Skills

### [`nl-mi-health`](skills/nl-mi-health/)

A personal health-data assistant for Mi Fitness. After user authorization, it can sync data, show sync status, generate weekly health reports, and answer natural-language questions about sleep, steps, heart rate, and activity.

Usage guide: [`SKILL.md`](skills/nl-mi-health/SKILL.md)

## Install

| Method | Best for |
| --- | --- |
| Ask your Agent | Install directly through a Skill-aware Agent. |
| `skills` CLI | One-command installation or selecting a specific Skill. |
| Clone and copy | Place the Skill in a project or Agent directory yourself. |

### 1. Ask your Agent

Send this to your Agent:

> Help me install this Skill: [https://github.com/qlql489/nl-skills/tree/main/skills/nl-mi-health](https://github.com/qlql489/nl-skills/tree/main/skills/nl-mi-health).

If the Agent supports installing Skills from GitHub URLs, it can download and place the Skill in a discoverable directory. Otherwise, use either method below.

### 2. Use the `skills` CLI

Install every Skill in this repository:

```bash
npx skills add qlql489/nl-skills
```

Install only `nl-mi-health`:

```bash
npx skills add qlql489/nl-skills --skill nl-mi-health
```

You can list the available Skills first or target a particular Agent:

```bash
npx skills add qlql489/nl-skills --list
npx skills add qlql489/nl-skills --skill nl-mi-health --agent codex
```

### 3. Clone and copy

```bash
git clone https://github.com/qlql489/nl-skills.git
mkdir -p your-project/.agents/skills/nl-mi-health
cp -R nl-skills/skills/nl-mi-health/. your-project/.agents/skills/nl-mi-health/
```

Common project-level locations are `.claude/skills/<skill-name>/` for Claude Code, `.agents/skills/<skill-name>/` for Codex when using the `skills` CLI, and `.agents/skills/<skill-name>/` for Cursor or generic Agents. Start a new Agent session or rescan the project after copying.

## Use

After installation, start requests with `/nl-mi-health`. For example:

- `/nl-mi-health Sync my Mi Fitness data.`
- `/nl-mi-health Generate a weekly health report.`
- `/nl-mi-health How has my sleep been over the past few months?`
- `/nl-mi-health How many steps did I take each day this month?`

On first use, the Skill checks its runtime requirements and installs its bundled dependencies. If authorization is needed, it opens a visible browser for you to complete the sign-in and security confirmation yourself. Future sync and query requests can then be handled normally.
