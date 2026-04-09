#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, statSync } from "node:fs";
import { join } from "node:path";

const KON_HOME = "/opt/kon";
const CONFIG_PATH = join(KON_HOME, "config.json");
const REPOS_DIR = join(KON_HOME, "repos");
const SESSIONS_DIR = join(KON_HOME, "sessions");
const KON_ENV = join(KON_HOME, "env");
const SYNC_MARKER = join(REPOS_DIR, ".last-sync");
const SESSION_USER_PREFIX = "kon-";

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function loadSessions() {
  const path = join(SESSIONS_DIR, "sessions.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveSessions(sessions) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, "sessions.json"), JSON.stringify(sessions, null, 2));
}

function requireSession(name) {
  if (!name) {
    console.error("Usage: kon <command> <session-name>");
    process.exit(1);
  }
  const sessions = loadSessions();
  if (!sessions[name]) {
    console.error(`Session "${name}" does not exist. Use 'kon list' to see sessions.`);
    process.exit(1);
  }
  return { sessions, session: sessions[name] };
}

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: opts.quiet ? "pipe" : "inherit", ...opts }).trim();
}

function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function sessionUserName(name) {
  return `${SESSION_USER_PREFIX}${name}`;
}

function sessionHome(name) {
  return `/home/${sessionUserName(name)}`;
}

function slugify(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase().slice(0, 32);
}

function tmuxSessionName(name) {
  return `kon-${name}`;
}

function userExists(username) {
  return runQuiet(`id ${username} 2>/dev/null`) !== "";
}

function tmuxSessionExists(sessionName) {
  return runQuiet(`tmux has-session -t ${sessionName} 2>/dev/null; echo $?`) === "0";
}

function allocatePorts(config, sessions) {
  const count = config.ports_per_session || 10;
  const start = config.port_range_start || 4000;
  const end = config.port_range_end || 9000;
  const used = new Set();
  for (const s of Object.values(sessions)) {
    if (s.ports) s.ports.forEach((p) => used.add(p));
  }
  const ports = [];
  for (let p = start; p < end && ports.length < count; p++) {
    if (!used.has(p)) ports.push(p);
  }
  return ports;
}

function readSliceMemoryMB(slice) {
  const raw = runQuiet(`cat /sys/fs/cgroup/${slice}/memory.current 2>/dev/null`);
  return raw ? Math.round(parseInt(raw) / 1024 / 1024) : null;
}

function isSyncFresh(maxAgeMinutes = 5) {
  if (!existsSync(SYNC_MARKER)) return false;
  const age = (Date.now() - statSync(SYNC_MARKER).mtimeMs) / 60000;
  return age < maxAgeMinutes;
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--creator" && args[i + 1]) {
      flags.creator = args[++i];
    } else if (args[i] === "--ssh-key" && args[i + 1]) {
      flags.sshKey = args[++i];
    } else if (args[i] === "--days" && args[i + 1]) {
      flags.days = parseInt(args[++i], 10);
    } else if (!args[i].startsWith("--")) {
      flags.positional = flags.positional || args[i];
    }
  }
  return flags;
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdList() {
  const sessions = loadSessions();
  const names = Object.keys(sessions);
  if (names.length === 0) {
    console.log("No sessions.");
    return;
  }

  console.log(`\n  ${"Name".padEnd(20)} ${"Creator".padEnd(12)} ${"Created".padEnd(22)} ${"Tmux".padEnd(8)} ${"Ports"}`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(22)} ${"─".repeat(8)} ${"─".repeat(15)}`);

  for (const name of names) {
    const s = sessions[name];
    const tmuxAlive = tmuxSessionExists(tmuxSessionName(name)) ? "active" : "stopped";
    const created = s.created_at ? new Date(s.created_at).toISOString().slice(0, 19).replace("T", " ") : "unknown";
    const creator = (s.creator || "-").padEnd(12);
    const ports = s.ports ? s.ports.join(", ") : "-";
    console.log(`  ${name.padEnd(20)} ${creator} ${created.padEnd(22)} ${tmuxAlive.padEnd(8)} ${ports}`);
  }
  console.log();
}

function cmdNew(name, flags = {}) {
  if (!name) {
    console.error("Usage: kon new <name> [--creator <who>] [--ssh-key <pubkey>]");
    process.exit(1);
  }

  name = slugify(name);
  const sessions = loadSessions();

  if (sessions[name]) {
    console.error(`Session "${name}" already exists. Use 'kon join ${name}' to attach.`);
    process.exit(1);
  }

  const config = loadConfig();
  const username = sessionUserName(name);
  const home = sessionHome(name);

  // Sync repos if cache is stale
  if (!isSyncFresh()) {
    console.log("Syncing repos before creating session...");
    cmdSync();
  } else {
    console.log("Repo cache is fresh, skipping sync.");
  }

  console.log(`\nCreating session "${name}"...`);

  // 1. Create linux user with restricted home dir and private /tmp
  if (!userExists(username)) {
    run(`useradd -m -s /bin/bash -G kon-sessions ${username}`);
    run(`passwd -l ${username}`);
    run(`chmod 700 ${home}`);
  }
  const tmpDir = `/tmp/kon-${name}`;
  mkdirSync(tmpDir, { recursive: true });
  run(`chown ${username}:${username} ${tmpDir}`);
  run(`chmod 700 ${tmpDir}`);

  // 2. Install SSH key if provided
  if (flags.sshKey) {
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "authorized_keys"), flags.sshKey.trim() + "\n");
    run(`chown -R ${username}:${username} ${sshDir}`);
    run(`chmod 700 ${sshDir}`);
    run(`chmod 600 ${sshDir}/authorized_keys`);
  }

  // 3. Clone repos for this user
  const reposBase = join(home, config.repos_dir || "repos");
  mkdirSync(reposBase, { recursive: true });

  for (const repo of config.repos) {
    const dest = join(reposBase, repo.name);
    const source = join(REPOS_DIR, repo.name);

    if (existsSync(source)) {
      console.log(`  Copying ${repo.name} from cache...`);
      cpSync(source, dest, { recursive: true });
    } else {
      console.log(`  Cloning ${repo.name}...`);
      run(`git clone ${repo.url} ${dest}`);
    }
  }

  // 4. Give user access to gh CLI (copy host auth)
  const ghConfigDir = join(home, ".config", "gh");
  const systemGhConfig = "/opt/kon/.config/gh/hosts.yml";
  if (existsSync(systemGhConfig)) {
    mkdirSync(ghConfigDir, { recursive: true });
    cpSync(systemGhConfig, join(ghConfigDir, "hosts.yml"));
  }

  // 5. Set up git config
  if (flags.creator) {
    const gitconfig = `[user]\n\tname = ${flags.creator}\n`;
    writeFileSync(join(home, ".gitconfig"), gitconfig);
  }

  // 6. Allocate ports for this session
  const ports = allocatePorts(config, sessions);

  // 7. Create bashrc additions
  const bashrcAddition = `
# kon session
export KON_SESSION="${name}"
export REPOS_DIR="${reposBase}"
export KON_PORTS="${ports.join(",")}"
export TMPDIR="${tmpDir}"
${existsSync(KON_ENV) ? `set -a; source ${KON_ENV}; set +a` : ""}
cd "${reposBase}"
`;
  const bashrcPath = join(home, ".bashrc");
  const existing = existsSync(bashrcPath) ? readFileSync(bashrcPath, "utf-8") : "";
  if (!existing.includes("KON_SESSION")) {
    writeFileSync(bashrcPath, existing + bashrcAddition);
  }

  // 8. Generate CLAUDE.md for AI context
  const repoList = config.repos.map((r) => `- \`${reposBase}/${r.name}\` — ${r.name} (cloned from ${r.url})`).join("\n");
  const claudeMd = `# Kon Session: ${name}

This is an isolated cloud dev environment managed by kon.

## Session Info
- **Session name:** ${name}
- **User:** ${username}
- **Home:** ${home}
- **Repos directory:** ${reposBase}
- **Private temp:** ${tmpDir}
${flags.creator ? `- **Creator:** ${flags.creator}` : ""}

## Repositories
${repoList}

## Allocated Ports
This session has ${ports.length} ports reserved for dev servers, previews, etc:
${ports.map((p) => `- \`${p}\``).join("\n")}

Use these ports when starting dev servers to avoid conflicts with other sessions.
Example: \`astro dev --port ${ports[0]}\`, \`node server.js --port ${ports[1]}\`

The full list is also available as \`$KON_PORTS\` (comma-separated) in the shell.

## Rules
- Only use the allocated ports listed above
- Do not modify files outside of ${home}
- Do not attempt to access other users' home directories
- Git push/pull is available via the pre-configured gh CLI
`;
  writeFileSync(join(home, "CLAUDE.md"), claudeMd);

  // 9. Set ownership on everything
  run(`chown -R ${username}:${username} ${home}`);

  // 10. Apply cgroup resource limits via systemd slice
  const sliceContent = `[Slice]
MemoryMax=2G
MemoryHigh=1536M
CPUQuota=200%
TasksMax=512
`;
  const slicePath = `/etc/systemd/system/kon-${name}.slice`;
  writeFileSync(slicePath, sliceContent);
  runQuiet("systemctl daemon-reload");

  // 11. Save session metadata
  sessions[name] = {
    created_at: new Date().toISOString(),
    creator: flags.creator || null,
    ports,
    slice: `kon-${name}.slice`,
  };
  saveSessions(sessions);

  // 12. Start tmux session under the cgroup slice and attach
  const tmuxName = tmuxSessionName(name);
  run(`systemd-run --slice=kon-${name}.slice --uid=$(id -u ${username}) --gid=$(id -g ${username}) --setenv=HOME=${home} --setenv=USER=${username} -p WorkingDirectory=${reposBase} -- tmux new-session -d -s ${tmuxName}`, { quiet: true });

  console.log(`\nSession "${name}" created.`);
  console.log(`  User:    ${username}`);
  console.log(`  Home:    ${home}`);
  console.log(`  Ports:   ${ports.join(", ")}`);
  if (flags.creator) console.log(`  Creator: ${flags.creator}`);
  console.log(`  Tmux:    ${tmuxName}`);
  console.log(`\nAttaching to tmux session...`);

  const child = spawn("su", ["-", username, "-c", `tmux attach-session -t ${tmuxName}`], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code || 0));
}

function cmdJoin(name) {
  const { session } = requireSession(name);
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);
  const config = loadConfig();
  const reposBase = join(sessionHome(name), config.repos_dir || "repos");

  if (!tmuxSessionExists(tmuxName)) {
    console.log(`Tmux session was closed. Starting a new one...`);
    run(`su - ${username} -c "tmux new-session -d -s ${tmuxName} -c ${reposBase}"`);
  }

  console.log(`Joining session "${name}"...`);
  const child = spawn("su", ["-", username, "-c", `tmux attach-session -t ${tmuxName}`], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code || 0));
}

function cmdDelete(name) {
  const { sessions } = requireSession(name);
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);

  console.log(`Deleting session "${name}"...`);

  if (tmuxSessionExists(tmuxName)) {
    runQuiet(`tmux kill-session -t ${tmuxName}`);
    console.log("  Killed tmux session.");
  }

  runQuiet(`pkill -u ${username}`);
  runQuiet("sleep 1");

  const slicePath = `/etc/systemd/system/kon-${name}.slice`;
  if (existsSync(slicePath)) {
    runQuiet(`systemctl stop kon-${name}.slice`);
    runQuiet(`rm ${slicePath}`);
    runQuiet("systemctl daemon-reload");
  }

  const tmpDir = `/tmp/kon-${name}`;
  if (existsSync(tmpDir)) runQuiet(`rm -rf ${tmpDir}`);

  if (userExists(username)) {
    run(`userdel -r ${username} 2>/dev/null || true`, { quiet: true });
    console.log(`  Deleted user ${username}.`);
  }

  delete sessions[name];
  saveSessions(sessions);
  console.log(`Session "${name}" deleted.`);
}

function cmdInfo(name) {
  const { session: s } = requireSession(name);
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);
  const home = sessionHome(name);
  const tmuxAlive = tmuxSessionExists(tmuxName);

  console.log(`\n  Session: ${name}`);
  console.log(`  User:    ${username}`);
  console.log(`  Home:    ${home}`);
  console.log(`  Created: ${s.created_at}`);
  console.log(`  Creator: ${s.creator || "-"}`);
  console.log(`  Tmux:    ${tmuxAlive ? "active" : "stopped"}`);
  console.log(`  Ports:   ${s.ports ? s.ports.join(", ") : "-"}`);

  const du = runQuiet(`du -sh ${home} 2>/dev/null`);
  if (du) console.log(`  Disk:    ${du.split("\t")[0]}`);

  if (s.slice) {
    const memMB = readSliceMemoryMB(s.slice);
    if (memMB !== null) console.log(`  Memory:  ${memMB}MB / 2048MB`);
  }

  const config = loadConfig();
  const reposBase = join(home, config.repos_dir || "repos");
  console.log(`  Repos:`);
  for (const repo of config.repos) {
    const repoPath = join(reposBase, repo.name);
    const branch = runQuiet(`git -C ${repoPath} branch --show-current 2>/dev/null`);
    const dirty = runQuiet(`git -C ${repoPath} status --porcelain 2>/dev/null`);
    const status = existsSync(repoPath) ? `${branch || "detached"}${dirty ? " (modified)" : ""}` : "missing";
    console.log(`    ${repo.name}: ${status}`);
  }
  console.log();
}

function cmdSync() {
  const config = loadConfig();
  mkdirSync(REPOS_DIR, { recursive: true });

  console.log("Syncing repos...");
  for (const repo of config.repos) {
    const dest = join(REPOS_DIR, repo.name);
    if (existsSync(dest)) {
      console.log(`  Updating ${repo.name}...`);
      runQuiet(`git -C ${dest} fetch --all --prune`);
      const defaultBranch = runQuiet(`git -C ${dest} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`)
        ?.replace("refs/remotes/origin/", "") || "main";
      runQuiet(`git -C ${dest} checkout ${defaultBranch}`);
      runQuiet(`git -C ${dest} reset --hard origin/${defaultBranch}`);
    } else {
      console.log(`  Cloning ${repo.name}...`);
      run(`git clone ${repo.url} ${dest}`, { quiet: true });
    }
  }

  writeFileSync(SYNC_MARKER, new Date().toISOString());
  console.log("Sync complete.");
}

function cmdUpdate(name) {
  const { session: s } = requireSession(name);
  const config = loadConfig();
  const reposBase = join(sessionHome(name), config.repos_dir || "repos");
  const username = sessionUserName(name);

  console.log(`Updating repos in session "${name}"...`);
  for (const repo of config.repos) {
    const repoPath = join(reposBase, repo.name);
    if (!existsSync(repoPath)) {
      console.log(`  ${repo.name}: missing, skipping`);
      continue;
    }
    const dirty = runQuiet(`git -C ${repoPath} status --porcelain 2>/dev/null`);
    if (dirty) {
      console.log(`  ${repo.name}: has uncommitted changes, skipping`);
      continue;
    }
    console.log(`  ${repo.name}: pulling...`);
    runQuiet(`su - ${username} -c "git -C ${repoPath} pull --ff-only" 2>/dev/null`);
  }
  console.log("Update complete.");
}

function cmdStatus() {
  const sessions = loadSessions();
  const names = Object.keys(sessions);

  if (names.length === 0) {
    console.log("No sessions.");
    return;
  }

  console.log(`\n  ${"Session".padEnd(20)} ${"Tmux".padEnd(8)} ${"Procs".padEnd(6)} ${"Memory".padEnd(10)} ${"Disk"}`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(10)} ${"─".repeat(8)}`);

  for (const name of names) {
    const s = sessions[name];
    const username = sessionUserName(name);
    const tmuxAlive = tmuxSessionExists(tmuxSessionName(name)) ? "active" : "stopped";
    const procs = runQuiet(`ps -u ${username} --no-headers 2>/dev/null | wc -l`).trim() || "0";
    const du = runQuiet(`du -sh ${sessionHome(name)} 2>/dev/null`)?.split("\t")[0] || "?";

    let mem = "?";
    if (s.slice) {
      const memMB = readSliceMemoryMB(s.slice);
      if (memMB !== null) mem = `${memMB}MB`;
    }

    console.log(`  ${name.padEnd(20)} ${tmuxAlive.padEnd(8)} ${procs.padEnd(6)} ${mem.padEnd(10)} ${du}`);
  }
  console.log();
}

function cmdSnapshot(name) {
  const { session: s } = requireSession(name);
  const config = loadConfig();
  const reposBase = join(sessionHome(name), config.repos_dir || "repos");
  const snapshotDir = join(SESSIONS_DIR, "snapshots", name);
  mkdirSync(snapshotDir, { recursive: true });

  const snapshot = { created_at: new Date().toISOString(), repos: {} };

  for (const repo of config.repos) {
    const repoPath = join(reposBase, repo.name);
    if (!existsSync(repoPath)) continue;

    const branch = runQuiet(`git -C ${repoPath} branch --show-current 2>/dev/null`);
    const sha = runQuiet(`git -C ${repoPath} rev-parse HEAD 2>/dev/null`);
    const stashList = runQuiet(`git -C ${repoPath} stash list 2>/dev/null`);
    const diff = runQuiet(`git -C ${repoPath} diff 2>/dev/null`);
    const diffStaged = runQuiet(`git -C ${repoPath} diff --staged 2>/dev/null`);

    snapshot.repos[repo.name] = { branch, sha, stash_count: stashList ? stashList.split("\n").length : 0 };

    if (diff) writeFileSync(join(snapshotDir, `${repo.name}.unstaged.patch`), diff);
    if (diffStaged) writeFileSync(join(snapshotDir, `${repo.name}.staged.patch`), diffStaged);
  }

  writeFileSync(join(snapshotDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  console.log(`Snapshot saved to ${snapshotDir}`);
  console.log(JSON.stringify(snapshot, null, 2));
}

function cmdCleanup(flags = {}) {
  const maxDays = flags.days || 7;
  const sessions = loadSessions();
  const now = Date.now();
  const stale = [];

  for (const [name, s] of Object.entries(sessions)) {
    const tmuxAlive = tmuxSessionExists(tmuxSessionName(name));
    const age = (now - new Date(s.created_at).getTime()) / (1000 * 60 * 60 * 24);
    if (!tmuxAlive && age > maxDays) {
      stale.push({ name, age: Math.floor(age) });
    }
  }

  if (stale.length === 0) {
    console.log(`No stale sessions (threshold: ${maxDays} days).`);
    return;
  }

  console.log(`\nStale sessions (tmux stopped, older than ${maxDays} days):`);
  for (const s of stale) {
    console.log(`  ${s.name} (${s.age} days old)`);
  }
  console.log(`\nRun 'kon delete <name>' to remove them.`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);
const flags = parseFlags(args);
const target = flags.positional || args[0];

switch (command) {
  case "list":
  case "ls":
    cmdList();
    break;
  case "new":
  case "create":
    cmdNew(target, flags);
    break;
  case "join":
  case "attach":
    cmdJoin(target);
    break;
  case "delete":
  case "rm":
    cmdDelete(target);
    break;
  case "info":
    cmdInfo(target);
    break;
  case "sync":
    cmdSync();
    break;
  case "update":
    cmdUpdate(target);
    break;
  case "status":
    cmdStatus();
    break;
  case "snapshot":
    cmdSnapshot(target);
    break;
  case "cleanup":
    cmdCleanup(flags);
    break;
  default:
    console.log(`
kon - Cloud dev environment manager

Usage:
  kon list                              List all sessions
  kon new <name> [--creator <who>]      Create a new session
                 [--ssh-key <pubkey>]
  kon join <name>                       Attach to an existing session
  kon delete <name>                     Delete a session
  kon info <name>                       Show session details
  kon status                            Health overview of all sessions
  kon sync                              Sync cached repos from GitHub
  kon update <name>                     Pull latest into session repos
  kon snapshot <name>                   Save session git state
  kon cleanup [--days <n>]              Find stale sessions (default: 7 days)
`);
    process.exit(command ? 1 : 0);
}
