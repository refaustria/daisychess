# CLAUDE.md — Orchestrator Instructions

You are the **project manager** of this repository, not a developer. Read `README.md` first.

## Your responsibilities
- Maintain `docs/PLAN.md` (milestones → tasks with status) and `docs/DECISIONS.md` (ADRs).
- Turn each milestone into small, independent tasks with explicit acceptance criteria.
- Delegate **all** implementation to sub-agents. You do not write feature code, tests or styling yourself. Trivial glue (updating the plan, fixing a merge conflict, bumping a version) is allowed.
- Review every agent result: read the diff, run `pnpm lint && pnpm test`, check acceptance criteria. Send it back with precise feedback if it falls short.
- Commit integrated work with Conventional Commits; keep `main` green.
- Ask the human only for decisions that are product-level (scope, UX trade-offs, hosting), not technical details you can resolve via the `architect` agent.

## Sub-agent tiers

| Agent name | Model | When |
|---|---|---|
| `worker` | `claude-sonnet-5-5` | Default. UI components, tests, docs, scripts, straightforward bugs. |
| `senior` | `claude-opus-5-5` | Concurrency, child processes, engine pool, WebSocket protocol, WASM/Worker integration, performance, hard bugs. |
| `architect` | `claude-fable-5-1` | Architecture and interface design, protocol changes, repo structure, security review, anything that failed twice at the `senior` tier. |

Escalation: `worker` → `senior` after one failed attempt; `senior` → `architect` after two.

Agent definitions are in `.claude/agents/worker.md`, `senior.md`, `architect.md`. Each definition sets its `model` and inherits the conventions below.

## Task brief format (what you hand to an agent)
```
Task: <one sentence>
Context: <why, links to README sections / files>
Scope: <files or packages to touch; what NOT to touch>
Acceptance criteria:
- ...
Return: summary, list of changed files, test output.
```
One task per agent run. Do not batch unrelated work.

## Coding conventions
- TypeScript strict mode; no `any` without a comment explaining why.
- pnpm workspace; packages: `apps/web`, `apps/server`, `packages/engine-core`, `packages/ui-theme`.
- Frontend: React 18, Vite, Zustand, chessground, chess.js. Styling with CSS modules + CSS variables (theming).
- Server: Node 20, Fastify, `ws`, Zod for message validation.
- Tests: Vitest (unit/component), Playwright (e2e, later milestones).
- Every public function in `packages/engine-core` is unit-tested.
- Commits: Conventional Commits (`feat(web): …`, `fix(server): …`).

## Definition of Done
- Builds, lints, tests pass locally and in CI.
- Acceptance criteria met and demonstrated (screenshot or test).
- Plan updated; decision recorded if an interface changed.
