# Kon

Infrastructure and dev environment orchestrator for Gaza Stack.

## What this repo does

**Server provisioning** — Single workflow_dispatch sets up a VPS from scratch: system hardening, nginx with wildcard SSL, GitHub CLI, Node.js, Claude Code, OpenAI Codex, and the sessions system.

**Sessions** — Isolated cloud dev environments. Each session is a Linux user with its own home dir, repo clones, allocated ports, cgroup resource limits, private /tmp, and pre-authenticated tools (gh, claude, codex). Sessions auto-install dependencies, start dev servers, and configure nginx subdomains. Managed via the `kon` CLI.

## Structure
- `.github/workflows/provision.yml` — Server provisioning (manual dispatch)
- `ansible/` — Playbooks and roles (common, nginx, certbot, sessions)
- `orchestrator/kon.mjs` — CLI entry point
- `orchestrator/lib/helpers.mjs` — Config, paths, shell helpers, template rendering
- `orchestrator/lib/session-create.mjs` — Session creation (deps, dev server, nginx, AI configs)
- `orchestrator/lib/session-manage.mjs` — Session management (join, delete, list, sync, etc.)
- `orchestrator/templates/session-claude.md` — CLAUDE.md template for sessions
- `orchestrator/templates/session-agents.md` — AGENTS.md template for sessions (OpenAI Codex)

## Kon CLI Commands
- `kon new <name>` — Create session (clones repos, installs deps, starts dev server, configures nginx)
- `kon join <name>` — Attach to existing session
- `kon delete <name>` — Tear down session and clean up (nginx, user, cgroup)
- `kon list` — List all sessions with URLs
- `kon info <name>` — Session details (repos, ports, memory, disk, URL)
- `kon status` — Health overview of all sessions
- `kon sync` — Update cached repo clones
- `kon update <name>` — Pull latest into a session's repos
- `kon snapshot <name>` — Save git state (branches, uncommitted changes)
- `kon cleanup` — Find stale sessions

## Session Workflow
1. Developer SSHs into server, runs `kon new my-feature`
2. Kon creates isolated user, clones repos, installs deps, starts dev server
3. Dev server accessible at `https://my-feature.<domain>`
4. Developer works in the session, pushes changes, opens PR via `gh pr create`
5. PR description includes dev server URL for reviewers
6. When done, `kon delete my-feature` tears everything down

## Required GitHub Secrets (set by frontend setup wizard)
- `VPS_SSH_KEY` / `VPS_HOST` — Server access
- `CLOUDFLARE_API_TOKEN` — Wildcard SSL via DNS challenge
- `KON_GITHUB_TOKEN` — PAT for gh CLI auth
- `ANTHROPIC_API_KEY` — Claude Code API key (optional)
- `OPENAI_API_KEY` — OpenAI Codex API key (optional)

## Rules
- AI must NEVER include itself as co-author in commits or anywhere else
- AI must NEVER add Co-Authored-By lines to commits
