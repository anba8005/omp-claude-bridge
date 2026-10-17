/**
 * Unit-suite preload: isolate tests from the developer's real HOME, omp agent
 * dir and Claude Code state.
 *
 * src/index.ts resolves the bridge log and diag paths into module-level consts at
 * import time (and mkdirs the log dir when CLAUDE_BRIDGE_DEBUG=1), so the
 * overrides have to be in place before any test imports the module. Doing that
 * per test file is easy to forget, and forgetting is invisible: the suite still
 * passes, but a config test writes the developer's real claude-bridge.json and
 * fixture data lands in the real bridge log.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts it took effect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_CODING_AGENT_SESSION_DIR = join(root, "sessions");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, "claude-bridge.log");
delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
