/**
 * The registered models are Claude Code's aliases, passed to it as-is, and omp's
 * thinking levels map onto Claude Code's effort ladder.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { effortFor, MODEL_ALIASES, MODELS } from "../src/models.js";

describe("MODELS", () => {
	it("registers only the opus, sonnet and haiku aliases", () => {
		assert.deepEqual(MODELS.map((m) => m.id), ["opus", "sonnet", "haiku"]);
		assert.deepEqual([...MODEL_ALIASES], ["opus", "sonnet", "haiku"]);
	});

	it("describes the 5.5 models the aliases resolve to: 1M context, 128K output, every effort", () => {
		for (const m of MODELS) {
			assert.doesNotMatch(m.id, /\[1m\]/, "the alias carries no [1m] suffix: Claude Code serves 1M by default");
			assert.equal(m.contextWindow, 1_000_000);
			assert.equal(m.maxTokens, 128_000);
			assert.equal(m.reasoning, true);
			assert.deepEqual(m.input, ["text", "image"]);
			assert.deepEqual(m.thinking, { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "xhigh", "max"] });
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
		assert.deepEqual(MODELS.map((m) => m.name), ["Claude Opus (latest)", "Claude Sonnet (latest)", "Claude Haiku (latest)"]);
	});
});

describe("effortFor", () => {
	it("sends no effort when thinking is off or unset", () => {
		assert.equal(effortFor(undefined), undefined);
		assert.equal(effortFor("off"), undefined);
	});

	it("passes Claude Code's levels through, minimal as low", () => {
		assert.equal(effortFor("minimal"), "low");
		for (const level of ["low", "medium", "high", "xhigh", "max"]) assert.equal(effortFor(level), level);
	});

	it("sends no effort for a level Claude Code does not have", () => {
		assert.equal(effortFor("extreme"), undefined);
	});
});
