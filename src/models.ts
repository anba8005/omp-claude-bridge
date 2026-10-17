// Model selection + display-order policy for the model picker. The picker is
// driven by the host's anthropic catalog (omp's pi-ai): models appear (and
// disappear) with it, no per-model code here. Extracted from index.ts so tests can import without
// activating the extension.
// `resolveModel` resolves family shortcuts (opus/sonnet/fable) to the newest
// matching id regardless of sort order; sort order only drives picker display.

const TWO_HUNDRED_K_CONTEXT = 200_000;
const ONE_M_CONTEXT = 1_000_000;

// pi-ai ships dated snapshot ids (claude-opus-4-5-20251101, ...) alongside the
// bare ids. They are never exposed - and must not steal first-partial-match
// shortcuts like "opus-4-5" from the bare id.
function isDatedAlias(id: string): boolean {
	return /-20\d{6}$/.test(id);
}

// Family tiers for display order: flagship families first; unknown families
// sink below all known ones.
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// newest generation first. Context-dependent display labels are applied after
// plan/long-context config is known.
// Version rank of a claude id, e.g. claude-opus-4-7 → ["opus", 4, 7]. Shared by
// the display sort and resolveModel's newest-first partial tiebreak.
function versionRank(id: string): { family: string; tuple: [number, number] } {
	const [, family, major, minor] = id.split("-");
	return { family, tuple: [Number(major) || 0, Number(minor) || 0] };
}

export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return piAiModels
		.filter((m) => typeof m.id === "string" && !isDatedAlias(m.id))
		.sort((a, b) => {
			const fa = FAMILY_ORDER.indexOf(versionRank(a.id).family);
			const fb = FAMILY_ORDER.indexOf(versionRank(b.id).family);
			const ta = fa === -1 ? FAMILY_ORDER.length : fa;
			const tb = fb === -1 ? FAMILY_ORDER.length : fb;
			if (ta !== tb) return ta - tb;
			const ra = versionRank(a.id).tuple;
			const rb = versionRank(b.id).tuple;
			if (ra[0] !== rb[0]) return rb[0] - ra[0];
			if (ra[1] !== rb[1]) return rb[1] - ra[1];
			return a.id.localeCompare(b.id);
		})
		// Forward the catalog's thinking metadata: omp's `thinking.efforts` is what its
		// picker offers per model (Opus 5.5 up to max, Haiku 4.5 without xhigh) and what
		// effortFor clamps to. Without it omp falls back to a generic minimal..high list.
		// pi-ai's thinkingLevelMap is kept for hosts that ship it instead.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinking, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens,
			...(thinking ? { thinking } : {}),
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// Claude Code's effort ladder, lowest first (the SDK's EffortLevel).
const EFFORT_LADDER = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeEffort = (typeof EFFORT_LADDER)[number];

// A host thinking level on a model without adaptive effort: the level is a budget
// tier, so the top tier asks for Claude Code's top effort.
const TIER_TO_EFFORT: Record<string, ClaudeCodeEffort> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

/**
 * The Claude Code effort for a host reasoning level, or undefined to leave
 * Claude Code at its default.
 *
 * omp's catalog says what its levels mean per model. On an `anthropic-adaptive`
 * model `thinking.efforts` are Anthropic's own efforts (Opus 5.5: low..max,
 * Sonnet 4.6: low..high), so the level passes through — `minimal`, which Claude
 * Code lacks, as low — and one the model does not list steps down to the highest
 * it does: asking for an effort the model lacks fails the turn, and omp only
 * clamps what its own picker offers, not what AskClaude passes. Any other mode
 * (`budget`, `anthropic-budget-effort`) lists budget tiers, minimal..xhigh, which
 * map onto the ladder with the top tier as max. A pi-ai thinkingLevelMap, when a
 * host ships one, wins outright (null there means "send no effort").
 */
export function effortFor(
	model: {
		thinking?: { mode?: string; efforts?: readonly string[] };
		thinkingLevelMap?: Record<string, string | null>;
	},
	reasoning: string | undefined,
): ClaudeCodeEffort | undefined {
	if (!reasoning || reasoning === "off") return undefined;
	const mapped = model.thinkingLevelMap?.[reasoning];
	if (mapped === null) return undefined;
	if (typeof mapped === "string" && (EFFORT_LADDER as readonly string[]).includes(mapped)) return mapped as ClaudeCodeEffort;
	if (model.thinking?.mode !== "anthropic-adaptive") return TIER_TO_EFFORT[reasoning];
	const requested = reasoning === "minimal" ? "low" : reasoning;
	const rank = (EFFORT_LADDER as readonly string[]).indexOf(requested);
	if (rank === -1) return undefined;
	const supported = model.thinking.efforts;
	if (!supported || supported.length === 0) return EFFORT_LADDER[rank];
	for (let i = rank; i >= 0; i--) {
		if (supported.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
	}
	return undefined;
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
	// Model ids whose declared 1M context Claude Code turned out not to serve;
	// forces bare id at 200K without a code change.
	forceTwoHundredK?: string[];
};

export type ClaudeCodeRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Measured Claude Agent SDK behavior - see diag/CONTEXT-SIZE.md:
// - The `[1m]` suffix is the only reliable way to request 1M context through
//   the SDK; bare ids serve 200K.
// - An unentitled `[1m]` id is rejected outright (400/429), failing every turn
//   — worse than serving 200K, so the default is bare id at 200K and only
//   measured-good ids get `[1m]`.
// - The registered contextWindow must match the window the bridge actually
//   requests, or pi's status bar and compaction threshold misreport.
// [1m] ids verified to serve 1M on every plan. A new model serves 200K until
// someone measures it (diag/context-size.mjs) and adds it here.
const MEASURED_ONE_M = new Set([
	"claude-fable-5",
	"claude-fable-5-1",
	"claude-opus-5",
	"claude-opus-4-8",
	"claude-opus-4-7",
	"claude-sonnet-5",
]);

// Measured exceptions: pi-ai declares 1M and the [1m] id works, but only when
// the plan allows it.
const PLAN_GATED_ONE_M: Record<string, (settings: LongContextSettings) => boolean> = {
	// [1m] measured 1M on Max plan / extra usage; 429 on Pro without it.
	"claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
	// [1m] measured 1M with extra usage only.
	"claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
};

export function resolveClaudeCodeRuntimeModel(
	model: { id: string },
	settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
	const modelId = model.id;
	if (settings.forceTwoHundredK?.includes(modelId)) {
		return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
	}
	if (MEASURED_ONE_M.has(modelId)) {
		return { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT };
	}
	const planGate = PLAN_GATED_ONE_M[modelId];
	if (planGate) {
		const useOneM = planGate(settings);
		return {
			cliModelId: useOneM ? `${modelId}[1m]` : modelId,
			contextWindow: useOneM ? ONE_M_CONTEXT : TWO_HUNDRED_K_CONTEXT,
		};
	}
	// No measured row: bare id at 200K, the safe default (see diag/CONTEXT-SIZE.md).
	return { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	// Exact first, then partial (mirrors pi's tryMatchModel ordering), so a
	// longer newer id containing the input (claude-fable-5-1 vs "claude-fable-5")
	// cannot shadow the exact match.
	return models.find((m) => m.id === lower)
		?? newestPartialMatch(models.filter((m) => m.id.includes(lower)));
}

// Newest match by version rank — independent of registration order.
function newestPartialMatch<T extends { id: string }>(candidates: T[]): T | undefined {
	if (candidates.length === 0) return undefined;
	return candidates.reduce((best, m) => {
		const [vb, vbest] = [versionRank(m.id).tuple, versionRank(best.id).tuple];
		const newer = vb[0] !== vbest[0] ? vb[0] > vbest[0] : vb[1] > vbest[1];
		return newer ? m : best;
	});
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport. The runtime policy is based
// on measured SDK behavior - see diag/CONTEXT-SIZE.md
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m, settings);
		const name = contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}
