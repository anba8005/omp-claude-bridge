#!/usr/bin/env node
/**
 * Load the bridge in a real omp and check what it registered.
 *
 * Usage: node tests/omp-smoke.mjs [path/to/src/index.ts]   (default: this repo's)
 *
 * The unit suite runs against pi's packages; omp serves the extension's
 * `@earendil-works/*` imports from its own bundled copies instead. A symbol omp
 * does not export, or a model field it reads differently, shows up only here.
 * Makes no model call: `omp models` loads the extension and lists its provider.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const entry = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"));

const result = spawnSync("omp", ["models", "claude-bridge", "--json", "--no-extensions", "-e", entry], {
	encoding: "utf8",
	timeout: 120_000,
});
const stderr = result.stderr ?? "";
assert.equal(result.status, 0, `omp models exited ${result.status}: ${stderr}`);
assert.doesNotMatch(stderr, /Failed to load extension/, stderr);

const { models } = JSON.parse(result.stdout);
const bridge = models.filter((model) => model.provider === "claude-bridge");
assert.deepEqual(bridge.map((model) => model.id).sort(), ["haiku", "opus", "sonnet"], "the extension registers Claude Code's aliases only");
for (const model of bridge) {
	assert.equal(model.contextWindow, 1_000_000, `${model.id}: contextWindow ${model.contextWindow}`);
	// The efforts must reach omp's picker; without them it falls back to a generic
	// minimal..high list.
	assert.deepEqual(model.thinking, ["low", "medium", "high", "xhigh", "max"], `${model.id}: thinking ${JSON.stringify(model.thinking)}`);
}

console.log(`omp loaded ${entry}: claude-bridge/${bridge.map((m) => m.id).join(", claude-bridge/")}`);
