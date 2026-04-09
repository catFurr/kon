# Kon

Infrastructure and dev environment orchestrator for Gaza Stack.

## What this repo does

**Deploy pipeline** — Reusable GitHub Actions workflow that any repo can call to build, deploy via Ansible, and post PR preview comments. Static sites are rsynced to nginx, served via wildcard subdomains with SSL.

**Server provisioning** — Single workflow_dispatch sets up a VPS from scratch: system hardening, nginx, certbot wildcard SSL, GitHub CLI, Node.js, Claude Code, and the sessions system.

**Sessions** — Isolated cloud dev environments. Each session is a Linux user with its own home dir, repo clones, allocated ports, cgroup resource limits, private /tmp, and pre-authenticated tools (gh, claude). Managed via the `kon` CLI.

## Structure
- `.github/workflows/deploy.yml` — Reusable deploy workflow (called by component repos)
- `.github/workflows/provision.yml` — Server provisioning (manual dispatch)
- `ansible/` — Playbooks and roles (common, nginx, certbot, deploy, sessions)
- `orchestrator/kon.mjs` — Session management CLI

## Kon CLI Commands
- `kon new <name>` — Create isolated dev session
- `kon join <name>` — Attach to existing session
- `kon delete <name>` — Tear down session
- `kon list` — List all sessions
- `kon info <name>` — Session details (repos, ports, memory, disk)
- `kon status` — Health overview of all sessions
- `kon sync` — Update cached repo clones
- `kon update <name>` — Pull latest into a session's repos
- `kon snapshot <name>` — Save git state (branches, uncommitted changes)
- `kon cleanup` — Find stale sessions

## Required GitHub Secrets
- `VPS_SSH_KEY` / `VPS_HOST` — Server access
- `CLOUDFLARE_API_TOKEN` — Wildcard SSL via DNS challenge
- `KON_GITHUB_TOKEN` — PAT for gh CLI auth
- `KON_REPOS` — JSON array of repos, e.g. `[{"name":"frontend","url":"..."}]`
- `ANTHROPIC_API_KEY` — Claude Code API key

## Rules
- AI must NEVER include itself as co-author in commits or anywhere else
- AI must NEVER add Co-Authored-By lines to commits
