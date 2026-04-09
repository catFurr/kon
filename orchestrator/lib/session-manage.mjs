import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfig, loadSessions, saveSessions, requireSession,
  run, runQuiet,
  sessionUserName, sessionHome, tmuxSessionName,
  userExists, tmuxSessionExists, readSliceMemoryMB,
  REPOS_DIR, SESSIONS_DIR, SYNC_MARKER,
} from "./helpers.mjs";
import { removeNginxConfig } from "./session-create.mjs";

// ── List ────────────────────────────────────────────────────────────────────

export function cmdList() {
  const sessions = loadSessions();
  const names = Object.keys(sessions);
  if (names.length === 0) {
    console.log("No sessions.");
    return;
  }

  console.log(`\n  ${"Name".padEnd(20)} ${"Creator".padEnd(12)} ${"URL".padEnd(35)} ${"Tmux"}`);
  console.log(`  ${"─".repeat(20)} ${"─".repeat(12)} ${"─".repeat(35)} ${"─".repeat(8)}`);

  for (const name of names) {
    const s = sessions[name];
    const tmuxAlive = tmuxSessionExists(tmuxSessionName(name)) ? "active" : "stopped";
    const creator = (s.creator || "-").padEnd(12);
    const url = (s.url || "-").padEnd(35);
    console.log(`  ${name.padEnd(20)} ${creator} ${url} ${tmuxAlive}`);
  }
  console.log();
}

// ── Join ────────────────────────────────────────────────────────────────────

export function cmdJoin(name) {
  requireSession(name);
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);
  const config = loadConfig();
  const reposBase = join(sessionHome(name), config.repos_dir || "repos");

  if (!tmuxSessionExists(tmuxName)) {
    console.log("Tmux session was closed. Starting a new one...");
    run(`su - ${username} -c "tmux new-session -d -s ${tmuxName} -c ${reposBase}"`);
  }

  console.log(`Joining session "${name}"...`);
  const child = spawn("su", ["-", username, "-c", `tmux attach-session -t ${tmuxName}`], {
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code || 0));
}

// ── Delete ──────────────────────────────────────────────────────────────────

export function cmdDelete(name) {
  const { sessions } = requireSession(name);
  const username = sessionUserName(name);
  const tmuxName = tmuxSessionName(name);

  console.log(`Deleting session "${name}"...`);

  if (tmuxSessionExists(tmuxName)) {
    runQuiet(`tmux kill-session -t ${tmuxName}`);
    console.log("  Killed tmux session.");
  }

  // Remove nginx config
  removeNginxConfig(name);
  console.log("  Removed nginx config.");

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

// ── Info ────────────────────────────────────────────────────────────────────

export function cmdInfo(name) {
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
  if (s.url) console.log(`  URL:     ${s.url}`);

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

// ── Sync ────────────────────────────────────────────────────────────────────

export function cmdSync() {
  const config = loadConfig();
  mkdirSync(REPOS_DIR, { recursive: true });

  console.log("Syncing repos...");
  for (const repo of config.repos) {
    const dest = join(REPOS_DIR, repo.name);
    if (existsSync(dest)) {
      console.log(`  Updating ${repo.name}...`);
      runQuiet(`git -C ${dest} fetch --all --prune`);
      const defaultBranch =
        runQuiet(`git -C ${dest} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`)?.replace(
          "refs/remotes/origin/",
          ""
        ) || "main";
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

// ── Update ──────────────────────────────────────────────────────────────────

export function cmdUpdate(name) {
  requireSession(name);
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

// ── Status ──────────────────────────────────────────────────────────────────

export function cmdStatus() {
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

// ── Snapshot ────────────────────────────────────────────────────────────────

export function cmdSnapshot(name) {
  requireSession(name);
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

// ── Cleanup ─────────────────────────────────────────────────────────────────

export function cmdCleanup(flags = {}) {
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
