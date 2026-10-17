#!/usr/bin/env node

/**
 * session_shutdown under omp, where task subagents run in-process on the
 * parent's module: a subagent's shutdown drops only its own mirror, and only
 * the main session's takes them all. A subagent's session_start leaves the
 * main session's UI handle in place.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

const handlers = new Map();
activate({
	on: (event, handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerProvider: () => {},
	registerTool: () => {},
});
const emit = (event, ...args) => {
	for (const handler of handlers.get(event) ?? []) handler(...args);
};
const ctx = (sessionId, kind) => ({
	agent: { kind },
	sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
	ui: { kind: `ui-${sessionId}`, notify: () => {} },
	mode: "interactive",
});
const mirror = (sessionId) => ({ sessionId: `cc-${sessionId}`, cursor: 2, cwd: process.cwd(), piSessionId: sessionId });

describe("session_shutdown", () => {
	beforeEach(() => __test.resetSharedSession());

	it("a subagent's shutdown drops only its own mirror", () => {
		__test.setSharedSession("parent", mirror("parent"));
		__test.setSharedSession("child", mirror("child"));
		emit("session_shutdown", {}, ctx("child", "sub"));
		assert.equal(__test.getSharedSession("child"), null);
		assert.deepEqual(__test.getSharedSession("parent"), mirror("parent"), "the parent's conversation survives");
	});

	it("the main session's shutdown drops every mirror", () => {
		__test.setSharedSession("parent", mirror("parent"));
		__test.setSharedSession("child", mirror("child"));
		emit("session_shutdown", {}, ctx("parent", "main"));
		assert.equal(__test.getSharedSession("parent"), null);
		assert.equal(__test.getSharedSession("child"), null);
	});
});

describe("session_start", () => {
	it("a subagent's session leaves the main session's UI handle", () => {
		const main = ctx("parent", "main");
		emit("session_start", {}, main);
		emit("session_start", {}, ctx("child", "sub"));
		assert.equal(__test.getPiUI(), main.ui);
	});
});
