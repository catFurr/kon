# Kon

A new way for development. AI-enabled isolated developer environments that you own.

Kon is the infrastructure backbone of Gaza Stack — a self-hosted alternative to Vercel, Netlify, and cloud IDEs. It gives you preview deployments, production deploys, and full cloud dev environments on your own server.

## Why

- **You own it.** Your server, your code, your data. No vendor lock-in.
- **AI-native.** Every dev session comes with Claude Code pre-authenticated and context-aware.
- **Isolated environments.** Each session is a sandboxed Linux user with its own repos, ports, resources, and tools.
- **Integrated deploys.** Push to a branch, get a preview URL. Merge to main, it's live. No config.

## How it works

### Deploy pipeline

Any repo can call Kon's reusable workflow to deploy:

```yaml
# In your repo's CI workflow
deploy:
  uses: catFurr/kon/.github/workflows/deploy.yml@main
  with:
    domain: yourdomain.com
    artifact_name: my-build
    environment: preview
```

Kon handles the rest: rsync to server, nginx routing, wildcard SSL, PR comments with preview URLs.

### Dev sessions

SSH into your server and spin up an isolated dev environment:

```
ssh kon@your-server
kon new my-feature
```

You get:
- A sandboxed Linux user with its own home directory
- Fresh clones of all your repos
- Pre-authenticated `gh` CLI and `claude` (Claude Code)
- Allocated ports for dev servers (no conflicts)
- cgroup resource limits (CPU, RAM, tasks)
- Private `/tmp` directory
- A `~/CLAUDE.md` that tells the AI agent about your session — repos, ports, rules

When you're done:

```
kon delete my-feature
```

### Server provisioning

One command sets up everything on a fresh VPS:

1. System hardening (firewall, hidepid, restricted home dirs)
2. Nginx with wildcard subdomain routing
3. Certbot wildcard SSL via Cloudflare DNS
4. Node.js, GitHub CLI, Claude Code
5. The Kon session system with hourly repo sync

## Architecture

```
gaza-stack/
├── kon/          ← This repo. Infrastructure & sessions.
└── frontend/     ← Astro static site. Calls kon's deploy workflow.
```

Kon is designed to manage multiple component repos. Each repo stays simple — just a build step and a one-liner to call Kon's deploy workflow.

## Getting started

1. Provision a VPS (Ubuntu)
2. Add GitHub secrets: `VPS_SSH_KEY`, `VPS_HOST`, `CLOUDFLARE_API_TOKEN`, `KON_GITHUB_TOKEN`, `KON_REPOS`, `ANTHROPIC_API_KEY`
3. Run the Provision workflow from the Actions tab
4. SSH as `kon@your-server` and start creating sessions
