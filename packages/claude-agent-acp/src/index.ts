#!/usr/bin/env node

// Load managed settings and apply environment variables
import { loadManagedSettings, applyEnvironmentSettings } from "./utils.js";
import { claudeCliPath, runAcp } from "./acp-agent.js";

// Parse --agent <name> before anything else so downstream code can read it
// from the environment. We remove the flag from argv so it doesn't confuse
// the Claude CLI if --cli is also passed.
const agentIdx = process.argv.indexOf("--agent");
if (agentIdx !== -1 && agentIdx + 1 < process.argv.length) {
  process.env.CLAUDE_AGENT_ACP_AGENT_NAME = process.argv[agentIdx + 1];
  process.argv.splice(agentIdx, 2);
}

if (process.argv.includes("--cli")) {
  process.argv = process.argv.filter((arg) => arg !== "--cli");
  await import(await claudeCliPath());
} else {
  const managedSettings = loadManagedSettings();
  if (managedSettings) {
    applyEnvironmentSettings(managedSettings);
  }

  // stdout is used to send messages to the client
  // we redirect everything else to stderr to make sure it doesn't interfere with ACP
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;

  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
  });

  runAcp();

  // Keep process alive
  process.stdin.resume();
}
