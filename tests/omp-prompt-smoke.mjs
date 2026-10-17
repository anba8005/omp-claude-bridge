#!/usr/bin/env node
/**
 * Run after every omp upgrade: what of omp's system prompt reaches Claude Code,
 * through the installed omp, for a session turn and for a subagent.
 *
 * Usage: node --import tsx tests/omp-prompt-smoke.mjs [path/to/src/index.ts]   (default: this repo's)
 *
 * The projection recognizes omp's harness by two markers (src/omp-prompt.ts). A
 * template change that slips past them is refused at runtime; this catches it
 * before any real request, including a rewrite that also loses every
 * HARNESS_SIGNATURES line. Nothing reaches Anthropic: every Claude Code process
 * talks to a local stub API with a stub key, non-essential traffic is off, and
 * omp's memory is off for the run.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { HARNESS_SIGNATURES } from "../src/omp-prompt.js";

const entry = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts"));
const MODEL = "claude-bridge/haiku";
const STUB_KEY = "sk-ant-stub";
const SKILL = "bridge-prompt-probe";
const TOOL = (name) => `mcp__custom-tools__${name}`;

const hasTool = (body, name) => (body.tools ?? []).some((tool) => tool.name === TOOL(name));
const isSubagent = (body) => hasTool(body, "yield");
const toolResults = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === "tool_result").length;

/** The scripted model: the session spawns one subagent and waits for it; everything else says OK. */
function reply(body) {
	if (hasTool(body, "task") && !isSubagent(body)) {
		const step = toolResults(body);
		if (step === 0) return { tool: "task", input: { i: "Probing the bridge", context: "omp-claude-bridge prompt smoke.", tasks: [{ task: "Reply OK.", solutionSpace: "none" }] } };
		if (step === 1) return { tool: "wait", input: { i: "Waiting for the probe" } };
	}
	return { text: "OK" };
}

function sse(body, n) {
	const event = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
	const { tool, input, text } = reply(body);
	const block = tool
		? [event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_stub_${n}`, name: TOOL(tool), input: {} } }),
			event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } })]
		: [event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })];
	return event("message_start", { type: "message_start", message: { id: `msg_stub_${n}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } })
		+ block.join("")
		+ event("content_block_stop", { type: "content_block_stop", index: 0 })
		+ event("message_delta", { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
		+ event("message_stop", { type: "message_stop" });
}

function stubApi(requests) {
	const server = createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) return res.writeHead(404).end();
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			requests.push({ headers: req.headers, body });
			res.writeHead(200, { "content-type": "text/event-stream" }).end(sse(body, requests.length));
		});
	});
	return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function run(cmd, args, options) {
	return new Promise((ok) => {
		const child = spawn(cmd, args, options);
		let output = "";
		child.stdout.on("data", (d) => { output += d; });
		child.stderr.on("data", (d) => { output += d; });
		const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
		child.on("close", (code) => { clearTimeout(timer); ok({ code, output }); });
	});
}

const requests = [];
const api = await stubApi(requests);
const root = mkdtempSync(join(tmpdir(), "omp-prompt-smoke-"));
try {
	const cwd = join(root, "workspace");
	mkdirSync(join(cwd, ".omp", "skills", SKILL), { recursive: true });
	writeFileSync(join(cwd, ".omp", "skills", SKILL, "SKILL.md"), `---\nname: ${SKILL}\ndescription: Fixture skill for the bridge prompt smoke.\n---\nProbe.\n`);
	const overlay = join(root, "overlay.yml");
	writeFileSync(overlay, [
		"modelRoles:", `  task: ${MODEL}`,
		"task:", "  agentModelOverrides:", `    task: ${MODEL}`,
		"memory:", "  backend: off",
	].join("\n") + "\n");

	const { code, output } = await run("omp", [
		"-p", "Spawn one subagent, wait for it, then reply OK.",
		"--model", MODEL, "--config", overlay, "--cwd", cwd,
		"--no-session", "--no-title", "--no-prewalk", "--no-extensions", "-e", entry,
	], {
		env: { ...process.env, ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: STUB_KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});

	const turns = requests.filter((r) => (r.body.tools ?? []).length > 0);
	const session = turns.filter((r) => hasTool(r.body, "task") && !isSubagent(r.body));
	const subagent = turns.filter((r) => isSubagent(r.body));
	assert.ok(session.length > 0, `no session request reached the stub (omp exited ${code}) — was the prompt refused?\n${output}`);
	assert.ok(subagent.length > 0, `no subagent request reached the stub — did the subagent run on ${MODEL}?\n${output}`);

	for (const [who, request] of [["session", session[0]], ["subagent", subagent[0]]]) {
		assert.equal(request.headers["x-api-key"], STUB_KEY, `${who}: Claude Code did not use the stub key`);
		assert.equal(request.headers.authorization, undefined, `${who}: a real credential reached the stub`);
		const system = request.body.system.map((block) => block.text).join("\n");
		assert.match(system, /Skills are specialized instructions/, `${who}: omp's harness was not recognized — check HARNESS_MARKERS in src/omp-prompt.ts`);
		assert.equal(system.split(SKILL).length - 1, 1, `${who}: the fixture skill should be listed exactly once`);
		for (const signature of HARNESS_SIGNATURES) assert.doesNotMatch(system, signature, `${who}: omp's harness reached Claude Code`);
	}

	const version = spawnSync("omp", ["--version"], { encoding: "utf8" }).stdout.trim();
	console.log(`${version}: session and subagent prompts projected; no harness line reached Claude Code (${requests.length} stub requests, none to Anthropic)`);
} finally {
	api.close();
	rmSync(root, { recursive: true, force: true });
}
