# NL Skills

A practical collection of AI Agent Skills, primarily documented in Chinese. Each self-contained Skill includes a `SKILL.md` contract for the agent and, where useful, scripts and reference material.

[中文文档](README.md)

## Available now

| Skill | What it is for |
| --- | --- |
| [`nl-mi-health`](nl-mi-health/SKILL.md) | Sync, inspect, and summarize cloud-accessible Mi Fitness health records and sport summaries; generate weekly reports; reauthorize through a visible browser session. |

## `nl-mi-health`

`nl-mi-health` is a local-first Node.js CLI packaged as an Agent Skill. It supports initial and watermark-based incremental sync, local JSONL and SQLite storage, raw record queries, summaries for sleep, steps, heart rate, and activity, plus weekly reports.

It never asks users to paste passwords, verification codes, cookies, or tokens. Sign-in happens in a visible Chrome window under the user's control, and local summaries are not sent to third parties.

## Install

Copy the Skill folder into the directory scanned by your agent. For example, for Codex at project scope:

```bash
git clone https://github.com/qlql489/nl-skills.git
cp -R nl-skills/nl-mi-health your-project/.codex/skills/
cd your-project/.codex/skills/nl-mi-health/scripts
npm install
```

Requirements: Node.js 22.13+ and Google Chrome. Other common project-level locations are `.claude/skills/<skill-name>/` for Claude Code and `.agents/skills/<skill-name>/` for Cursor or generic agents.

## Common commands

Run these from `nl-mi-health/scripts`:

```bash
node mi_fitness_health.mjs auth-status
node mi_fitness_health.mjs login
node mi_fitness_health.mjs sync
node mi_fitness_health.mjs weekly-report
node mi_fitness_health.mjs summary --metric sleep --since 2022-01-01 --group-by year
```

See [`nl-mi-health/SKILL.md`](nl-mi-health/SKILL.md) for the full command reference, data boundaries, and troubleshooting guidance.

## Privacy and scope

Data is stored locally by default under `~/.nl-mi-health/health-data`, with authorization state under `~/.nl-mi-health/auth/`. “Complete sync” means only the records and summaries actually returned by the Mi cloud APIs for the current account and region; it does not include deleted, unavailable, or undocumented data. Never commit or share authorization files, cookies, tokens, SQLite databases, or raw JSONL files.
