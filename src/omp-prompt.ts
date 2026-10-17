// What of omp's system prompt reaches Claude Code, and which provider calls are
// one-off summaries rather than conversation turns.
//
// omp hands a provider its system prompt as ordered blocks (buildSystemPrompt's
// `systemPrompt: string[]`), and every provider call carries the blocks it was
// built from — including a subagent's own prompt and any block an extension
// returned from before_agent_start. So the projection is a pure function of the
// call: no recording at lifecycle events, no keyed lookup to miss, nothing to
// inherit across module instances.
//
// The blocks omp renders for a session:
//   - the harness: omp's own role, engineering policy and tool guidance, which
//     embeds the skill catalogue and the rules. Claude Code's preset carries its
//     own, so the harness never ships — only its skills and rules sections do;
//   - eval prelude guidance, one block per active prelude;
//   - `<project-context>`: workstation, context files (AGENTS.md and friends),
//     directory rules, workspace roots, and the session's append prompt.
// Blocks other than the harness are forwarded verbatim. That keeps whatever an
// extension added, which is the instruction loss upstream's capture registry
// existed to prevent: a turn that silently drops policy the user wrote down.
// The one exception fails closed: a forwarded block that still carries the
// harness (HARNESS_SIGNATURES) means omp's template outgrew the markers, and the
// projection throws rather than ship it.

import { MCP_TOOL_PREFIX } from "./skills.js";

export type SkillReadTool = "mcp" | "none";

type SystemPromptInput = string | readonly string[] | undefined | null;

/** The prompt as omp's ordered blocks; a plain string is one block. Empty blocks drop out. */
export function systemPromptBlocks(systemPrompt: SystemPromptInput): string[] {
	if (systemPrompt == null) return [];
	const blocks = typeof systemPrompt === "string" ? [systemPrompt] : [...systemPrompt];
	return blocks.filter((block): block is string => typeof block === "string" && block.trim().length > 0);
}

/** The prompt as one string, for places that take a single system prompt. */
export function systemPromptText(systemPrompt: SystemPromptInput): string | undefined {
	const blocks = systemPromptBlocks(systemPrompt);
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

// omp's bundled system-prompt.md opens with its RFC 2119 preamble and names
// itself in the role line. A block carrying either is omp's harness. A custom
// prompt (`--system-prompt`, SYSTEM.md) renders through a different template
// without them, and is the user's own text, so it is forwarded whole.
const HARNESS_MARKERS = [/^RFC 2119 keywords:/, /\bYou are omp's\b/];

export function isOmpHarnessBlock(block: string): boolean {
	return HARNESS_MARKERS.some((marker) => marker.test(block));
}

// Lines only omp's harness carries. A template change that drops both markers
// would otherwise ship the whole harness as an ordinary block, so a forwarded
// block carrying any of these is refused rather than sent. The § sections a
// subagent's own block uses (Role, Context, Coop, Completion) are not here, and
// `<project-context>` is not checked: it holds the user's context files, which
// may quote anything.
export const HARNESS_SIGNATURES = [
	/^RFC 2119 keywords:/m,
	/\bYou are omp's\b/,
	/^§ Runtime$/m,
	/^§ Tool Policy$/m,
	/^§ Workflow$/m,
	/^§ Delivery$/m,
];

function refuseHarness(block: string): void {
	const found = HARNESS_SIGNATURES.find((signature) => signature.test(block));
	if (!found) return;
	const line = block.match(found)![0];
	throw new Error(
		`claude-bridge refused to send omp's system prompt to Claude Code: it carries omp's harness ("${line}"). ` +
		"omp's prompt template changed; update HARNESS_MARKERS in src/omp-prompt.ts.",
	);
}

const PROJECT_CONTEXT_OPEN = "<project-context>";

export function isProjectContextBlock(block: string): boolean {
	return block.trimStart().startsWith(PROJECT_CONTEXT_OPEN);
}

/** `<tag>…</tag>` from a block, tags included, or undefined when absent. */
function taggedSection(block: string, tag: string): string | undefined {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = block.indexOf(open);
	if (start === -1) return undefined;
	const end = block.indexOf(close, start + open.length);
	if (end === -1) return undefined;
	return block.slice(start, end + close.length);
}

/**
 * The harness's skills and rules, re-introduced for Claude Code.
 *
 * Skills and domain rules are addressed by `skill://` and `rule://` URLs, which
 * omp's own read tool resolves. Claude Code reaches that tool only over MCP, so
 * without a served `read` these sections would point at files nothing can open,
 * and they are dropped. Always-apply rules carry their full text and need no
 * reader.
 */
function harnessSections(block: string, readTool: SkillReadTool): string[] {
	const sections: string[] = [];
	const readName = `${MCP_TOOL_PREFIX}read`;
	const skills = readTool === "mcp" ? taggedSection(block, "skills") : undefined;
	if (skills) {
		sections.push(
			`Skills are specialized instructions. When one matches the task, read \`skill://<name>\` with the ${readName} tool before proceeding.\n${skills}`,
		);
	}
	const genericRules = taggedSection(block, "generic-rules");
	if (genericRules) sections.push(`These rules always apply:\n${genericRules}`);
	const domainRules = readTool === "mcp" ? taggedSection(block, "domain-rules") : undefined;
	if (domainRules) {
		sections.push(
			`Domain rules apply to files matching their globs. Before working on such files, read \`rule://<name>\` with the ${readName} tool.\n${domainRules}`,
		);
	}
	return sections;
}

/**
 * What to append after Claude Code's own preset for one provider call, or
 * undefined when nothing portable is left.
 */
export function projectOmpSystemPrompt(
	systemPrompt: SystemPromptInput,
	options: { skillReadTool: SkillReadTool },
): string | undefined {
	const parts: string[] = [];
	for (const block of systemPromptBlocks(systemPrompt)) {
		if (isOmpHarnessBlock(block)) parts.push(...harnessSections(block, options.skillReadTool));
		else {
			if (!isProjectContextBlock(block)) refuseHarness(block);
			parts.push(block.trim());
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * Whether a provider call is a one-off summary rather than a conversation turn.
 *
 * omp's summarizers — compaction, turn prefix, short summary, handoff, branch
 * summary — reach the registered provider through completeSimple with their own
 * system prompt and a single user message carrying the serialized history. Run
 * as a turn, that request would sync into the shared Claude Code session and
 * replace the conversation it is summarizing. A session turn always carries the
 * session prompt (harness or `<project-context>` block) and its tools, so the
 * shape alone separates the two without depending on which summarizer called.
 */
export function isOneOffRequest(context: {
	systemPrompt?: SystemPromptInput;
	messages: readonly { role: string }[];
	tools?: readonly unknown[];
}): boolean {
	if (context.messages.length !== 1 || context.messages[0].role !== "user") return false;
	if (context.tools && context.tools.length > 0) return false;
	return !systemPromptBlocks(context.systemPrompt).some(
		(block) => isOmpHarnessBlock(block) || isProjectContextBlock(block),
	);
}
