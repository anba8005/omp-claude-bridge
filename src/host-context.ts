/**
 * Normalize omp's provider input into the context shape the bridge speaks.
 *
 * omp adds a `developer` role to the user/assistant/toolResult messages a
 * provider receives: date and cwd reminders, todo nudges, auto-continue prompts,
 * turn-recovery notes. omp's own Anthropic provider sends each one as a `user`
 * turn and skips one with no content, so the bridge does the same. Everything
 * downstream — the history/prompt split, the session cursor, the rebuild import
 * — then sees the conversation the API would have seen.
 *
 * Applied once at each provider entry point, so every length taken from
 * `context.messages` afterwards counts the same messages.
 */
import type { Context } from "@earendil-works/pi-ai";

type HostMessage = { role: string; content?: unknown; [key: string]: unknown };

function hasContent(content: unknown): boolean {
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some((block: { type?: string; text?: string }) =>
		block?.type === "image" || (block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0),
	);
}

/** Id of the newest `reset_boundary` entry omp's /clear left on a branch, or null. */
export function latestResetBoundaryId(branch: readonly { type?: string; id?: string }[] | undefined): string | null {
	if (!Array.isArray(branch)) return null;
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "reset_boundary" && typeof entry.id === "string" && entry.id) return entry.id;
	}
	return null;
}

export function toBridgeContext(context: Context): Context {
	const messages = context.messages as unknown as HostMessage[];
	if (!messages.some((message) => message.role === "developer")) return context;
	const normalized = messages
		.filter((message) => message.role !== "developer" || hasContent(message.content))
		.map((message) => (message.role === "developer" ? { ...message, role: "user" } : message));
	return { ...context, messages: normalized as unknown as Context["messages"] };
}

/**
 * Identity of a conversation: its first message's role and timestamp (its content
 * when untimed). Lets the session sync tell the conversation it mirrors, arriving
 * rewound, from another conversation (a subagent, an AskClaude child).
 */
export function conversationOrigin(messages: Context["messages"]): string | undefined {
	const first = messages[0] as { role?: string; timestamp?: number; content?: unknown } | undefined;
	if (!first) return undefined;
	return first.timestamp !== undefined
		? `${first.role}@${first.timestamp}`
		: `${first.role}:${JSON.stringify(first.content ?? "").slice(0, 200)}`;
}
