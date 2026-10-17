/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

describe("syncSharedSession", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	// omp opens a fresh session with developer reminders (date, cwd) ahead of the first user
	// message. They are user turns on the wire — omp's own Anthropic provider sends them as
	// such — so they belong to the prompt, not to history: a fresh session must still take
	// the clean-start path rather than rebuild a session file holding only a reminder.
	it("takes the clean-start path when a developer reminder precedes the first user message", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const context = __test.toBridgeContext({
				messages: [
					{ role: "developer", content: "Current date: 2026-10-17", timestamp: Date.now() },
					{ role: "user", content: "Hello", timestamp: Date.now() },
				],
			});
			const result = __test.syncSharedSession(context.messages, cwd);

			assert.equal(result.sessionId, null, "a reminder ahead of the first prompt is part of the prompt, not prior history");
			assert.equal(result.preserveSharedSession, undefined);
			assert.equal(__test.getSharedSession(null), null, "a clean start must not create a session state");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// omp retries a reply that stopped without actionable output by dropping that reply and
	// appending a reminder, so the same conversation arrives shorter than the cursor with no
	// event to mark it. It must rebuild from what omp still has — not take the subagent
	// branch, which runs the turn with no history at all.
	it("rebuilds when its own conversation arrives rewound, and a subagent never touches it", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const t0 = 1_760_000_000_000;
		const history = [
			{ role: "user", content: "Hi", timestamp: t0 },
			{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: t0 + 1 },
			{ role: "user", content: "Do the thing", timestamp: t0 + 2 },
		];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			]);
			seeded.save();
			const shared = { sessionId, cursor: 3, cwd, piSessionId: "parent", origin: __test.conversationOrigin(history) };

			__test.setSharedSession("parent", shared);
			const subagent = __test.syncSharedSession(
				[{ role: "user", content: "Search the repo", timestamp: t0 + 50 }], cwd, undefined, undefined, "child");
			assert.equal(subagent.sessionId, null, "a subagent starts clean in its own mirror");
			assert.deepEqual(__test.getSharedSession("parent"), shared, "the parent's mirror is untouched");

			const retry = __test.syncSharedSession(
				[...history, { role: "user", content: "Stopped without actionable output", timestamp: t0 + 4 }],
				cwd, undefined, undefined, "parent",
			);
			assert.equal(retry.sessionId, sessionId, "the rewound conversation rebuilds in place and resumes");
			assert.equal(retry.preserveSharedSession, undefined);
			assert.equal(__test.getSharedSession("parent")?.cursor, 2);
			const session = openSession({ sessionId, projectPath: cwd });
			assert.deepEqual(session.messages.map((m) => m.type), ["user", "assistant"], "the retry keeps its history");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// An empty developer message (omp sends ones that carry only provider controls) is skipped
	// on the wire. It must not count toward the cursor either, or the next turn's reuse check
	// (priors >= cursor) sees a message Claude Code never got and rebuilds every turn.
	it("keeps cursor arithmetic consistent when empty developer messages punctuate the history", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			]);
			seeded.save();
			__test.setSharedSession(null, { sessionId, cursor: 2, cwd });

			const context = __test.toBridgeContext({
				messages: [
					{ role: "user", content: "Hi", timestamp: Date.now() },
					{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
					{ role: "developer", content: "", timestamp: Date.now() },
					{ role: "user", content: "Next", timestamp: Date.now() },
				],
			});
			const result = __test.syncSharedSession(context.messages, cwd);

			assert.equal(result.sessionId, sessionId, "2 priors at cursor 2 must resume, not rebuild");
			assert.equal(__test.getSharedSession(null)?.cursor, 2, "an empty developer message is not history");
			const session = openSession({ sessionId, projectPath: cwd });
			assert.deepEqual(
				session.messages.map((m) => m.type),
				["user", "assistant"],
				"the resumed session file must hold the conversation history",
			);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The branch this exercises is the guard that stops a reentrant subagent from
	// resuming — and then overwriting — the parent's session: a subagent's context
	// is shorter than the parent's cursor, so it starts fresh and the parent's
	// session is preserved. It was previously described here as the compact-summary
	// path, which cannot reach syncSharedSession at all, so the branch read as
	// covered for a case that never happens.
	it("starts a fresh session for a shorter context and preserves the parent's", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		try {
			const mainSession = {
				sessionId: "11111111-1111-4111-8111-111111111111",
				cursor: 42,
				cwd,
			};
			__test.setSharedSession(null, mainSession);

			const result = __test.syncSharedSession([
				{
					role: "user",
					content: "Summarize this conversation.",
					timestamp: Date.now(),
				},
			], cwd);

			assert.equal(
				result.sessionId,
				null,
				"a context shorter than the cursor — a subagent, or AskClaude — must start a fresh Claude Code session instead of resuming the parent's",
			);
			assert.equal(
				result.preserveSharedSession,
				true,
				"the fresh session must not replace the parent's when it completes",
			);
			assert.deepEqual(__test.getSharedSession(null), mainSession);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// omp mints a fresh provider session id at /clear while its events carry the session
	// file's id, so a compaction after a /clear marks another mirror than the one serving
	// the turns, and the compacted history reaches this one shorter and unmarked — its
	// first message no longer the one the mirror recorded. On a session's own mirror that
	// is still its conversation rewound: it must rebuild, not run the turn with no history.
	it("rebuilds a session's own shorter history even when its first message changed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		try {
			createSession({ sessionId, projectPath: cwd }).save();
			__test.setSharedSession("own", { sessionId, cursor: 6, cwd, piSessionId: "own", origin: "user@1" });

			const result = __test.syncSharedSession([
				{ role: "user", content: "Compaction summary", timestamp: 100 },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: 101 },
				{ role: "user", content: "Next", timestamp: 102 },
			], cwd, undefined, undefined, "own");

			assert.equal(result.sessionId, sessionId, "rebuilt in place from omp's history");
			assert.equal(result.preserveSharedSession, undefined);
			assert.equal(__test.getSharedSession("own")?.cursor, 2);
			const session = openSession({ sessionId, projectPath: cwd });
			assert.deepEqual(session.messages.map((m) => m.type), ["user", "assistant"]);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The rebuilt file holds one line per record, and a carried `@file` expansion
	// is an `attachment` record — which `session.messages` filters out. Counting
	// messages told every user who at-mentioned a file before switching providers
	// that their session was corrupt, and asked them to open an issue about it.
	it("does not report a count mismatch when a rebuild carries an attachment", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
		const sessionId = randomUUID();
		const prompt = "Review @fixture.txt and remember it.";
		const notices = [];
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages(
				[
					{ role: "user", content: prompt },
					{ role: "assistant", content: [{ type: "text", text: "Noted." }] },
				],
				{
					attachments: [{
						afterIndex: 0,
						attachment: {
							type: "file",
							filename: join(cwd, "fixture.txt"),
							content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
						},
					}],
				},
			);
			seeded.save();

			__test.setSharedSession(null, { sessionId, cursor: 0, cwd });
			__test.setPiUI({ notify: (message) => notices.push(message) });
			__test.syncSharedSession([
				{ role: "user", content: prompt, timestamp: Date.now() },
				{ role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
				{ role: "user", content: "Now what did it say?", timestamp: Date.now() },
			], cwd);

			assert.equal(
				openSession({ sessionId, projectPath: cwd }).attachments.length,
				1,
				"the rebuild did not carry the attachment, so this proves nothing about the count",
			);
			assert.deepEqual(notices, []);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
