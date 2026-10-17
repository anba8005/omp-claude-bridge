// The directory Claude Code runs in, and loads project instructions from, must be the
// omp session's, not the host process's: an omp subagent in an isolated worktree
// shares the process but works elsewhere. omp passes the session cwd on every turn
// (`options.cwd`); its summarizers (compaction, branch summary, handoff) pass only the
// session id, so the cwd a session's turns carried is remembered for them. Kept on
// globalThis because every bridge module instance serves the same provider.
const SESSION_CWDS_KEY = Symbol.for("claude-bridge:sessionCwds");

function store(): Map<string, string> {
	const g = globalThis as Record<symbol, unknown>;
	return (g[SESSION_CWDS_KEY] ??= new Map<string, string>()) as Map<string, string>;
}

/** The cwd for a provider call: its own, else the one its session's turns carried, else the process's. */
export function cwdForCall(options: { cwd?: string; sessionId?: string } | undefined): string {
	if (options?.cwd) {
		if (options.sessionId) store().set(options.sessionId, options.cwd);
		return options.cwd;
	}
	return (options?.sessionId ? store().get(options.sessionId) : undefined) ?? process.cwd();
}
