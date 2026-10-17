#!/usr/bin/env node
// omp's provider input normalized to the bridge's context shape (toBridgeContext)
// and /clear detection (latestResetBoundaryId).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { latestResetBoundaryId, toBridgeContext } from "../src/host-context.js";

describe("toBridgeContext", () => {
	it("returns a context without developer messages unchanged", () => {
		const context = { systemPrompt: ["a"], messages: [{ role: "user", content: "hi" }] };
		assert.equal(toBridgeContext(context), context);
	});

	it("sends developer messages as user turns, as omp's Anthropic provider does", () => {
		const reminder = { role: "developer", content: [{ type: "text", text: "Today: 2026-10-17" }], timestamp: 1 };
		const { messages } = toBridgeContext({
			messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [] }, reminder],
		});
		assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
		assert.deepEqual(messages[2].content, reminder.content);
		assert.equal(messages[2].timestamp, 1);
	});

	it("skips a developer message with nothing to send, keeping image-only ones", () => {
		const { messages } = toBridgeContext({
			messages: [
				{ role: "developer", content: "  " },
				{ role: "developer", content: [] },
				{ role: "developer", content: [{ type: "image", data: "x", mimeType: "image/png" }] },
				{ role: "user", content: "hi" },
			],
		});
		assert.deepEqual(messages.map((m) => m.role), ["user", "user"]);
		assert.equal(messages[0].content[0].type, "image");
	});
});

describe("latestResetBoundaryId", () => {
	it("finds the newest /clear marker on a branch", () => {
		const branch = [
			{ type: "message", id: "a" },
			{ type: "reset_boundary", id: "r1" },
			{ type: "message", id: "b" },
			{ type: "reset_boundary", id: "r2" },
			{ type: "message", id: "c" },
		];
		assert.equal(latestResetBoundaryId(branch), "r2");
	});

	it("is null for a branch that was never cleared, or no branch", () => {
		assert.equal(latestResetBoundaryId([{ type: "message", id: "a" }]), null);
		assert.equal(latestResetBoundaryId(undefined), null);
	});
});
