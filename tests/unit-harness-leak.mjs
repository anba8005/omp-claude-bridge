/**
 * A session turn whose system prompt still carries omp's harness — omp changed
 * its template and the markers no longer catch it — ends as a failed call before
 * Claude Code starts. Nothing reaches Anthropic, and the empty turn leaves omp
 * free to walk retry.fallbackChains.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-harness-leak-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];

// omp's harness after a template change that dropped both markers.
const LEAKED_HARNESS = [
	"Keywords follow RFC 2119.",
	"",
	"§ Role",
	"You are a trusted coding assistant.",
	"",
	"§ Tool Policy",
	"# General",
	"Resolve prerequisites first.",
].join("\n");

const calls = [];

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	calls.length = 0;
	setQuery((args) => {
		calls.push(args);
		const gen = (async function* () {})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

afterEach(() => setQuery(null));

describe("a turn whose prompt still carries omp's harness", () => {
	it("fails before Claude Code starts, leaving the turn empty", async () => {
		const reply = await providerConfig.streamSimple(model, {
			systemPrompt: [LEAKED_HARNESS, "<project-context>\n</project-context>"],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
			tools: [],
		}, { sessionId: "pi-harness-leak" }).result();

		assert.equal(calls.length, 0, "Claude Code must not start");
		assert.equal(reply.stopReason, "error");
		assert.deepEqual(reply.content, [], "an empty failed turn is one omp can fall back from");
		assert.match(reply.errorMessage, /§ Tool Policy/);
	});
});
