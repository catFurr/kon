#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const KON_HOME = "/opt/kon";
const CONFIG_PATH = join(KON_HOME, "config.json");
const REPOS_DIR = join(KON_HOME, "repos");
const SESSIONS_DIR = join(KON_HOME, "sessions");
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

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdList() {
  const sessions = loadSessions();
  const names = Object.keys(sessions);
  if (names.length === 0) {
    console.log("No sessions.");
    return;
  }

  console.log(`\n  ${"Name".padEnd(20)} ${"User".padEnd(15)} ${"Created".padEnd(22)} ${"Tmux"}`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(15)} ${"─".repeat(22)} ${"─".repeat(8)}`);

  for (const name of names) {
    const s = sessions[name];
    const user = sessionUserName(name);
    const tmuxAlive = tmuxSessionExists(tmuxSessionName(name)) ? "active" : "stopped";
    const created = s.created_at ? new Date(s.created_at).toISOString().slice(0, 19).replace("T", " ") : "unknown";
    console.log(`  ${name.padEnd(20)} ${user.padEnd(15)} ${created.padEnd(22)} ${tmuxAlive}`);
  }
  console.log();
}

function cmdNew(name) {
  if (!name) {
    console.error("Usage: kon new <session-name>");
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

  console.log(`Creating session "${name}"...`);

  // 1. Create linux user
  if (!userExists(username)) {
    run(`useradd -m -s /bin/bash ${username}`);
    run(`passwd -l ${username}`);
  }

  // 2. Clone repos for this user
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

  // 3. Give user access to gh CLI (copy host auth)
  const ghConfigDir = join(home, ".config", "gh");
  const systemGhConfig = "/opt/kon/.config/gh/hosts.yml";
  if (existsSync(systemGhConfig)) {
    mkdirSync(ghConfigDir, { recursive: true });
    cpSync(systemGhConfig, join(ghConfigDir, "hosts.yml"));
  }

  // 4. Create bashrc additions
  const KON_ENV = join(KON_HOME, "env");
  const bashrcAddition = `
# kon session
export KON_SESSION="${name}"
export REPOS_DIR="${reposBase}"
${existsSync(KON_ENV) ? `set -a; source ${KON_ENV}; set +a` : ""}
cd "${reposBase}"
`;
  const bashrcPath = join(home, ".bashrc");
  const existing = existsSync(bashrcPath) ? readFileSync(bashrcPath, "utf-8") : "";
  if (!existing.includes("KON_SESSION")) {
    writeFileSync(bashrcPath, existing + bashrcAddition);
  }

  // 5. Set ownership on everything
  run(`chown -R ${username}:${username} ${home}`);

  // 6. Save session metadata
  sessions[name] = {
    created_at: new Date().toISOString(),
    username,
    home,
  };
  saveSessions(sessions);

  // 9. Start tmux session and attach
  const tmuxName = tmuxSessionName(name);
  run(`su - ${username} -c "tmux new-session -d -s ${tmuxName} -c ${reposBase}"`);

  console.log(`\nSession "${name}" created.`);
  console.log(`  User: ${username}`);
  console.log(`  Home: ${home}`);
  console.log(`  Repos: ${reposBase}`);
  console.log(`  Tmux: ${tmuxName}`);
  console.log(`\nAttaching to tmux session...`);

  // Attach interactively
  const child = spawn("su", ["-", username, "-c", `tmux attach-session -t ${tmuxName}`], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code || 0));
}

function cmdJoin(name) {
  if (!name) {
    console.error("Usage: kon join <session-name>");
    process.exit(1);
  }

  const sessions = loadSessions();
  if (!sessions[name]) {
    console.error(`Session "${name}" does not exist. Use 'kon list' to see sessions.`);
    process.exit(1);
  }

  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);
  const home = sessionHome(name);
  const config = loadConfig();
  const reposBase = join(home, config.repos_dir || "repos");

  // If tmux session doesn't exist, recreate it
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
  if (!name) {
    console.error("Usage: kon delete <session-name>");
    process.exit(1);
  }

  const sessions = loadSessions();
  if (!sessions[name]) {
    console.error(`Session "${name}" does not exist.`);
    process.exit(1);
  }

  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);

  console.log(`Deleting session "${name}"...`);

  // 1. Kill tmux session
  if (tmuxSessionExists(tmuxName)) {
    runQuiet(`tmux kill-session -t ${tmuxName}`);
    console.log("  Killed tmux session.");
  }

  // 2. Kill all user processes
  runQuiet(`pkill -u ${username}`);

  // 3. Delete linux user and home directory
  if (userExists(username)) {
    // Small delay to let processes die
    runQuiet("sleep 1");
    run(`userdel -r ${username} 2>/dev/null || true`, { quiet: true });
    console.log(`  Deleted user ${username}.`);
  }

  // 4. Remove session metadata
  delete sessions[name];
  saveSessions(sessions);

  console.log(`Session "${name}" deleted.`);
}

function cmdInfo(name) {
  if (!name) {
    console.error("Usage: kon info <session-name>");
    process.exit(1);
  }

  const sessions = loadSessions();
  if (!sessions[name]) {
    console.error(`Session "${name}" does not exist.`);
    process.exit(1);
  }

  const s = sessions[name];
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);
  const tmuxAlive = tmuxSessionExists(tmuxName);

  console.log(`\n  Session: ${name}`);
  console.log(`  User:    ${username}`);
  console.log(`  Home:    ${s.home}`);
  console.log(`  Created: ${s.created_at}`);
  console.log(`  Tmux:    ${tmuxAlive ? "active" : "stopped"}`);

  // Show disk usage
  const du = runQuiet(`du -sh ${s.home} 2>/dev/null`);
  if (du) console.log(`  Disk:    ${du.split("\t")[0]}`);

  // Show repos
  const config = loadConfig();
  const reposBase = join(s.home, config.repos_dir || "repos");
  console.log(`  Repos:`);
  for (const repo of config.repos) {
    const repoPath = join(reposBase, repo.name);
    const branch = runQuiet(`git -C ${repoPath} branch --show-current 2>/dev/null`);
    const status = existsSync(repoPath) ? (branch || "detached") : "missing";
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
      // Reset default branch to latest
      const defaultBranch = runQuiet(`git -C ${dest} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`)
        ?.replace("refs/remotes/origin/", "") || "main";
      runQuiet(`git -C ${dest} checkout ${defaultBranch}`);
      runQuiet(`git -C ${dest} reset --hard origin/${defaultBranch}`);
    } else {
      console.log(`  Cloning ${repo.name}...`);
      run(`git clone ${repo.url} ${dest}`, { quiet: true });
    }
  }
  console.log("Sync complete.");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

const target = args[0];

switch (command) {
  case "list":
  case "ls":
    cmdList();
    break;
  case "new":
  case "create":
    cmdNew(target);
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
  default:
    console.log(`
kon - Cloud dev environment manager

Usage:
  kon list              List all sessions
  kon new <name>        Create a new session
  kon join <name>       Attach to an existing session
  kon delete <name>     Delete a session
  kon info <name>       Show session details
  kon sync              Sync cached repos from GitHub
`);
    process.exit(command ? 1 : 0);
}
