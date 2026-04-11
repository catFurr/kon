# Kon

Infrastructure and dev environment orchestrator for Gaza Stack.

## What this repo does

**Server provisioning** — Single workflow_dispatch sets up a VPS from scratch: system hardening, nginx with wildcard SSL, Docker, GitHub CLI, Node.js, Claude Code, OpenAI Codex, and the sessions system.

**Sessions** — Isolated cloud dev environments. Each session is a Linux user with its own home dir, repo clones, allocated ports, cgroup resource limits, private /tmp, and pre-authenticated tools (gh, claude, codex). Sessions support multiple repos (including monorepos with sub-paths), git submodules, multiple dev servers per session, and Docker Compose services with per-session network isolation. Managed via the `kon` CLI.

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
- `kon new <name>` — Create session (clones repos, installs deps, starts all services, configures nginx)
- `kon join <name>` — Attach to existing session
- `kon delete <name>` — Tear down session and clean up (nginx, Docker, user, cgroup)
- `kon list` — List all sessions with URLs and service count
- `kon info <name>` — Session details (repos, services, ports, memory, disk)
- `kon status` — Health overview of all sessions
- `kon sync` — Update cached repo clones (with submodule support)
- `kon update <name>` — Pull latest into a session's repos
- `kon snapshot <name>` — Save git state (branches, uncommitted changes)
- `kon secrets reload <name>` — Re-decrypt vault secrets to .env files
- `kon cleanup` — Find stale sessions

## Session Workflow
1. Developer SSHs into server, runs `kon new my-feature`
2. Kon creates isolated user, clones repos (with submodules), installs deps
3. Starts all configured services: dev servers on allocated ports, Docker Compose with network isolation
4. Each dev service gets its own nginx subdomain: `<service>-<session>.<domain>`
5. Developer works, pushes changes, opens PR via `gh pr create`
6. When done, `kon delete my-feature` tears everything down (including Docker containers)

## Config Model (config.json)
Each repo can define multiple services:
- `type: "dev"` — Standard dev server (gets allocated port + nginx subdomain)
- `type: "docker"` — Docker Compose (runs with per-session network isolation via `COMPOSE_PROJECT_NAME`)
- `submodules: true` — Clones with `--recurse-submodules`, installs deps in submodule dirs
- Repos with no services defined fall back to auto-detection from package.json

## Stack Configuration (`stack.json`)
All non-secret config lives in `stack.json` at the repo root. Updated by the installer/wizard after forking:
- `domain`, `vps_host`, `github_user` — server identity
- `repos` — array of repos with services, submodules config
- `ports_per_session`, `port_range_start`, `port_range_end` — port allocation

The provision workflow reads this file directly via `ansible-playbook -e @../stack.json`.

## GitHub Secrets (credentials only, set on kon fork)
- `VPS_SSH_KEY` — SSH private key for server access
- `CLOUDFLARE_API_TOKEN` — Wildcard SSL via DNS challenge
- `KON_GITHUB_TOKEN` — PAT for gh CLI auth
- `ANTHROPIC_API_KEY` — Claude Code API key (optional)
- `OPENAI_API_KEY` — OpenAI Codex API key (optional)
- `VAULT_PASSWORD` — Ansible Vault password for per-project secrets (optional)

## Per-Project Secrets (Ansible Vault)
Repos can include a `vault/` directory with encrypted YAML files (e.g., `vault/dev.yml`, `vault/staging.yml`). During session creation and updates, these are auto-decrypted to `.env.{name}` files in the repo root (e.g., `.env.dev`). Files are flat key-value YAML converted to `KEY=VALUE` .env format. Requires `VAULT_PASSWORD` secret. Use `kon secrets reload <session>` to manually re-decrypt.

## Rules
- AI must NEVER include itself as co-author in commits or anywhere else
- AI must NEVER add Co-Authored-By lines to commits
