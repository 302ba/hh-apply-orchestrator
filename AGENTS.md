## Branch Model

This repo uses a lightweight gitflow layout:

- **`main`** — release branch. Always empty / one commit ahead of the most recent release. Protected.
- **`develop`** — integration branch. All step commits land here. This is the default branch day-to-day.
- **Feature / step branches** — branched off `develop`, merged back via PR (e.g. `step-02-ci`).

Rule of thumb: every prompt in `prompt_plan.md` lands as a commit on `develop` (or a short-lived feature branch merged into `develop`). Releases are cut by fast-forwarding `main` to a tagged commit on `develop`.

## Code Style

This project uses [Biome](https://biomejs.dev/) enforces: single quotes, 2-space indent, trailing commas, semicolons, LF line endings.

## Task Tracking

- **Always check TODO.md** before starting work
- **Update TODO.md** as tasks are completed (`[x]`), started (`[~]`), or skipped (`[-]`)
- Keep TODO.md as the single source of truth for project status

# Agent Rules

- Always use TypeScript.
- No any types.
- No duplicate code.
- Keep functions under 50 lines.
- Write tests for business logic.
- Update todo.md after completing tasks.
- Never introduce dependencies without explanation.

# Project Instructions

## Use Context7 by Default

Always use context7 when I need code generation, setup or configuration steps, or library/API documentation. This means you should automatically use the Context7 MCP tools to resolve library id and get library docs without me having to explicitly ask.
