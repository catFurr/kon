import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ───────────────────────────────────────────────────────────────────

export const KON_HOME = "/opt/kon";
export const CONFIG_PATH = join(KON_HOME, "config.json");
export const REPOS_DIR = join(KON_HOME, "repos");
export const SESSIONS_DIR = join(KON_HOME, "sessions");
export const KON_ENV = join(KON_HOME, "env");
export const SYNC_MARKER = join(REPOS_DIR, ".last-sync");
export const VAULT_PASS_FILE = join(KON_HOME, ".vault-pass");
export const SESSION_USER_PREFIX = "kon-";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const TEMPLATES_DIR = join(__dirname, "..", "templates");

// ── Constants ──────────────────────────────────────────────────────────────

export const SVC_TYPE = { DOCKER: "docker", DOCKER_EXPOSED: "docker-exposed", DEV: "dev" };

// ── Config ──────────────────────────────────────────────────────────────────

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found at ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

// ── Sessions data ───────────────────────────────────────────────────────────

export function loadSessions() {
  const path = join(SESSIONS_DIR, "sessions.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function saveSessions(sessions) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  writeFileSync(join(SESSIONS_DIR, "sessions.json"), JSON.stringify(sessions, null, 2));
}

export function requireSession(name) {
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

// ── Shell helpers ───────────────────────────────────────────────────────────

export function run(cmd, opts = {}) {
  const result = execSync(cmd, { encoding: "utf-8", stdio: opts.quiet ? "pipe" : "inherit", ...opts });
  return result ? result.trim() : "";
}

export function runQuiet(cmd) {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

const ADJECTIVES = [
  "swift", "calm", "bold", "warm", "cool", "keen", "pure", "soft",
  "fair", "glad", "wise", "kind", "free", "deep", "vast", "true",
  "bright", "noble", "vivid", "rapid", "fresh", "quiet", "gentle",
  "steady", "clear", "golden", "silver", "crimson", "amber", "coral",
];
const NOUNS = [
  "river", "cloud", "stone", "flame", "cedar", "brook", "ridge",
  "maple", "crane", "pearl", "bloom", "frost", "grove", "haven",
  "shore", "crest", "meadow", "harbor", "summit", "breeze",
  "canyon", "delta", "ember", "forge", "island", "lotus", "oasis",
  "petal", "reef", "tide",
];

export function randomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}`;
}

export function slugify(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase().slice(0, 32);
}

export function sessionUserName(name) {
  return `${SESSION_USER_PREFIX}${name}`;
}

export function sessionHome(name) {
  return `/home/${sessionUserName(name)}`;
}

export function tmuxSessionName(name) {
  return `kon-${name}`;
}

export function userExists(username) {
  return runQuiet(`id ${username} 2>/dev/null`) !== "";
}

export function tmuxSessionExists(sessionName) {
  return runQuiet(`tmux has-session -t ${sessionName} 2>/dev/null; echo $?`) === "0";
}

export function resolveVars(str, vars) {
  return str.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? "");
}

export function serviceUrl(name, domain, subdomain, httpServerCount) {
  return httpServerCount === 1
    ? `https://${name}.${domain}`
    : `https://${subdomain}-${name}.${domain}`;
}

// ── Port allocation ────────────────────────────────────────────────────────

export function countServices(config) {
  let count = 0;
  for (const repo of config.repos || []) {
    const services = repo.services || [];
    if (services.length === 0) {
      count += 1; // auto-detect fallback
      continue;
    }
    for (const svc of services) {
      if (svc.type === SVC_TYPE.DOCKER) {
        count += (svc.expose || []).length;
      } else {
        count += 1;
      }
    }
  }
  return count;
}

export function allocatePorts(config, sessions) {
  const serviceCount = countServices(config);
  const minPorts = config.ports_per_session || 10;
  const count = Math.max(minPorts, serviceCount + 5); // services + buffer
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

export function readSliceMemoryMB(slice) {
  const raw = runQuiet(`cat /sys/fs/cgroup/${slice}/memory.current 2>/dev/null`);
  return raw ? Math.round(parseInt(raw) / 1024 / 1024) : null;
}

export function isSyncFresh(maxAgeMinutes = 5) {
  if (!existsSync(SYNC_MARKER)) return false;
  const age = (Date.now() - statSync(SYNC_MARKER).mtimeMs) / 60000;
  return age < maxAgeMinutes;
}

export function parseFlags(args) {
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

// ── Template rendering ──────────────────────────────────────────────────────

export function renderTemplate(templatePath, vars) {
  const template = readFileSync(templatePath, "utf-8");
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ── Docker lifecycle helpers ────────────────────────────────────────────────

export async function pollHealthCheck(url, intervalMs = 3000, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
}

export function runPostUpCommands(commands, vars) {
  for (const cmd of commands) {
    const resolved = resolveVars(cmd, vars);
    console.log(`  Running: ${resolved}`);
    run(resolved);
  }
}

// ── Vault secrets ──────────────────────────────────────────────────────────

function yamlToEnv(yamlStr) {
  return yamlStr
    .split("\n")
    .filter(line => line.trim() && !line.trim().startsWith("#"))
    .map(line => {
      const match = line.match(/^(\w+)\s*:\s*(.*)$/);
      if (!match) return null;
      const [, key, raw] = match;
      const value = raw.replace(/^["']|["']$/g, "").trim();
      return `${key}=${value}`;
    })
    .filter(Boolean)
    .join("\n") + "\n";
}

export function decryptVaultFiles(repoPath, username) {
  const vaultDir = join(repoPath, "vault");
  if (!existsSync(vaultDir) || !existsSync(VAULT_PASS_FILE)) return [];

  const files = readdirSync(vaultDir).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"));
  const decrypted = [];

  for (const file of files) {
    const envName = file.replace(/\.ya?ml$/, "");
    const vaultFile = join(vaultDir, file);
    const envFile = join(repoPath, `.env.${envName}`);

    const yamlContent = runQuiet(
      `ansible-vault view "${vaultFile}" --vault-password-file "${VAULT_PASS_FILE}"`
    );

    if (!yamlContent) {
      console.log(`    Warning: Failed to decrypt ${file}`);
      continue;
    }

    const envContent = yamlToEnv(yamlContent);
    writeFileSync(envFile, envContent, { mode: 0o600 });

    if (username) {
      runQuiet(`chown ${username}:${username} "${envFile}"`);
    }

    decrypted.push(envName);
  }

  return decrypted;
}

export function decryptRepoVaults(config, reposBase, username) {
  if (!existsSync(VAULT_PASS_FILE)) return;

  for (const repo of config.repos) {
    const repoPath = join(reposBase, repo.name);
    const decrypted = decryptVaultFiles(repoPath, username);
    if (decrypted.length > 0) {
      console.log(`  ${repo.name}: ${decrypted.map(n => `.env.${n}`).join(", ")}`);
    }
  }
}
