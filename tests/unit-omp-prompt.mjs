#!/usr/bin/env node
// What of omp's system prompt reaches Claude Code (projectOmpSystemPrompt), and
// which provider calls are one-off summaries (isOneOffRequest).
//
// The block layout mirrors a provider call captured from omp 18.8.9 with one
// extension appending a block from before_agent_start: [harness,
// <project-context>, extension block]. The text is trimmed, the structure is not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	isOmpHarnessBlock,
	isOneOffRequest,
	projectOmpSystemPrompt,
	systemPromptBlocks,
	systemPromptText,
} from "../src/omp-prompt.js";

const HARNESS = [
	"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
	"",
	"§ Role",
	"You are omp's trusted coding assistant.",
	"",
	"§ Runtime",
	"# Skills & Rules",
	"Matching skill → MUST read `skill://<name>` first.",
	"<skills>",
	"- browser: Drive a headless browser.",
	"</skills>",
	"",
	"<generic-rules>",
	"Never commit secrets.",
	"</generic-rules>",
	"",
	"<domain-rules>",
	"- sql (**/*.sql): House SQL style.",
	"</domain-rules>",
	"",
	"# Internal URLs",
	"- skill://",
].join("\n");

const PROJECT = [
	"<project-context>",
	"<workstation>",
	"- OS: linux",
	"</workstation>",
	"",
	"<repo-rules>",
	"MUST follow these context files for all tasks:",
	'<file path="/repo/AGENTS.md">',
	"Always write tests first.",
	"</file>",
	"</repo-rules>",
	"</project-context>",
	"",
	"<critical>",
	"- Each response MUST advance the task.",
	"</critical>",
].join("\n");

const EXTENSION = "EXTENSION BLOCK: remember to cite sources.";

describe("projectOmpSystemPrompt", () => {
	it("keeps omp's harness out and forwards every other block verbatim", () => {
		const append = projectOmpSystemPrompt([HARNESS, PROJECT, EXTENSION], { skillReadTool: "mcp" });
		assert.doesNotMatch(append, /You are omp's trusted coding assistant/);
		assert.doesNotMatch(append, /RFC 2119/);
		assert.ok(append.includes(PROJECT), "the project block — context files included — ships whole");
		assert.ok(append.includes(EXTENSION), "a block an extension added ships whole");
	});

	it("carries the harness's skills and rules, pointing Claude Code at the MCP read tool", () => {
		const append = projectOmpSystemPrompt([HARNESS, PROJECT], { skillReadTool: "mcp" });
		assert.match(append, /<skills>\n- browser: Drive a headless browser\.\n<\/skills>/);
		assert.match(append, /read `skill:\/\/<name>` with the mcp__custom-tools__read tool/);
		assert.match(append, /<generic-rules>\nNever commit secrets\.\n<\/generic-rules>/);
		assert.match(append, /read `rule:\/\/<name>` with the mcp__custom-tools__read tool/);
		assert.doesNotMatch(append, /# Internal URLs/, "nothing else of the harness comes along");
	});

	it("drops sections only a reader can use when no read tool is served", () => {
		const append = projectOmpSystemPrompt([HARNESS, PROJECT], { skillReadTool: "none" });
		assert.doesNotMatch(append, /<skills>/);
		assert.doesNotMatch(append, /<domain-rules>/);
		assert.match(append, /<generic-rules>/, "always-apply rules carry their text and need no reader");
	});

	it("forwards a custom system prompt whole: it is the user's text, not omp's harness", () => {
		const custom = "You are a terse reviewer.\n<skills>\n<skill name=\"x\">y</skill>\n</skills>";
		assert.equal(isOmpHarnessBlock(custom), false);
		const append = projectOmpSystemPrompt([custom, PROJECT], { skillReadTool: "mcp" });
		assert.ok(append.startsWith(custom));
	});

	it("emits nothing for an empty prompt", () => {
		assert.equal(projectOmpSystemPrompt(undefined, { skillReadTool: "mcp" }), undefined);
		assert.equal(projectOmpSystemPrompt([], { skillReadTool: "mcp" }), undefined);
		assert.equal(projectOmpSystemPrompt([HARNESS.replace(/<skills>[\s\S]*<\/domain-rules>/, "")], { skillReadTool: "mcp" }), undefined);
	});

	it("accepts a single-string prompt as one block", () => {
		assert.deepEqual(systemPromptBlocks("one"), ["one"]);
		assert.equal(systemPromptText(["a", " ", "b"]), "a\n\nb");
	});
});

describe("isOneOffRequest", () => {
	const summary = {
		systemPrompt: ["You are a context summarization assistant."],
		messages: [{ role: "user", content: [{ type: "text", text: "<conversation>…</conversation>" }] }],
	};

	it("recognizes omp's summarizer shape: own prompt, one user message, no tools", () => {
		assert.equal(isOneOffRequest(summary), true);
		assert.equal(isOneOffRequest({ ...summary, tools: [] }), true);
	});

	it("never takes a session turn for one, even its first", () => {
		const first = { messages: summary.messages, tools: [{ name: "read" }] };
		assert.equal(isOneOffRequest({ ...first, systemPrompt: [HARNESS, PROJECT] }), false, "tools mark a turn");
		assert.equal(isOneOffRequest({ ...summary, systemPrompt: [HARNESS, PROJECT] }), false, "the session prompt marks a turn");
		assert.equal(isOneOffRequest({ ...summary, systemPrompt: ["custom", PROJECT] }), false, "a custom prompt still carries the project block");
		assert.equal(
			isOneOffRequest({ ...summary, messages: [...summary.messages, { role: "assistant" }, { role: "user" }] }),
			false,
			"a conversation is not a summary",
		);
	});
});
