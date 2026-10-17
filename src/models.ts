// The models the bridge registers: Claude Code's own model aliases. Extracted
// from index.ts so tests can import without activating the extension.
//
// Claude Code resolves `opus`, `sonnet` and `haiku` to the newest model of each
// family (https://code.claude.com/docs/en/model-config#model-aliases), and
// those run with the 1M context window by default, so the alias goes to Claude
// Code as-is: no catalog lookup, no `[1m]` suffix, and a new model reaches omp
// when Claude Code moves the alias. To pin a version, set Claude Code's
// ANTHROPIC_DEFAULT_OPUS_MODEL / _SONNET_MODEL / _HAIKU_MODEL for the omp process.

// Claude Code's effort ladder, lowest first (the SDK's EffortLevel).
const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeEffort = (typeof EFFORT_LADDER)[number];

// What the aliases resolve to today (Opus 5.5, Sonnet 5.5, Haiku 5.5): 1M
// context, 128K output, adaptive thinking at every effort level. `thinking` is
// in omp's catalog shape, which its picker reads.
const ALIAS_SPEC = {
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	thinking: { mode: "anthropic-adaptive", efforts: [...EFFORT_LADDER] },
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;

export const MODELS = MODEL_ALIASES.map((alias) => ({
	id: alias,
	name: `Claude ${alias[0].toUpperCase()}${alias.slice(1)} (latest)`,
	...ALIAS_SPEC,
}));

/**
 * The Claude Code effort for a host reasoning level, or undefined to leave
 * Claude Code at its default. The aliased models take every effort on the
 * ladder; omp's `minimal`, which Claude Code lacks, asks for low.
 */
export function effortFor(reasoning: string | undefined): ClaudeCodeEffort | undefined {
	if (!reasoning || reasoning === "off") return undefined;
	const requested = reasoning === "minimal" ? "low" : reasoning;
	return (EFFORT_LADDER as readonly string[]).includes(requested) ? requested as ClaudeCodeEffort : undefined;
}
