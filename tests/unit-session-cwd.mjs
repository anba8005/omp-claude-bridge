#!/usr/bin/env node
// Which directory Claude Code runs in for each kind of omp provider call (cwdForCall).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cwdForCall } from "../src/session-cwd.js";

describe("cwdForCall", () => {
	it("uses the cwd omp passes with a turn, not the process's", () => {
		assert.equal(cwdForCall({ cwd: "/work/tree-a", sessionId: "s-a" }), "/work/tree-a");
	});

	it("gives a summarizer call, which carries only the session id, its session's cwd", () => {
		cwdForCall({ cwd: "/work/tree-b", sessionId: "s-b" });
		cwdForCall({ cwd: "/work/tree-c", sessionId: "s-c" });
		assert.equal(cwdForCall({ sessionId: "s-b" }), "/work/tree-b");
		assert.equal(cwdForCall({ sessionId: "s-c" }), "/work/tree-c");
	});

	it("falls back to the process cwd for a session it has not seen", () => {
		assert.equal(cwdForCall({ sessionId: "never-seen" }), process.cwd());
		assert.equal(cwdForCall(undefined), process.cwd());
	});
});
