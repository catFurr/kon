#!/usr/bin/env node

import { parseFlags } from "./lib/helpers.mjs";
import { cmdNew } from "./lib/session-create.mjs";
import {
  cmdList, cmdJoin, cmdDelete, cmdInfo,
  cmdSync, cmdUpdate, cmdStatus, cmdSnapshot, cmdCleanup,
} from "./lib/session-manage.mjs";

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
  kon new <name> [--creator <who>]      Create session (clones repos, installs deps, starts dev server)
                 [--ssh-key <pubkey>]
  kon join <name>                       Attach to an existing session
  kon delete <name>                     Delete a session and clean up
  kon list                              List all sessions
  kon info <name>                       Show session details
  kon status                            Health overview of all sessions
  kon sync                              Sync cached repos from GitHub
  kon update <name>                     Pull latest into session repos
  kon snapshot <name>                   Save session git state
  kon cleanup [--days <n>]              Find stale sessions (default: 7 days)
`);
    process.exit(command ? 1 : 0);
}
