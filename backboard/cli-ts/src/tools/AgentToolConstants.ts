export const DEFAULT_AGENT_MAX_DEPTH = 2;

export const NON_DELEGATABLE_AGENT_TOOLS: ReadonlySet<string> = new Set([
	"ask_user",
	"browser",
	"computer",
]);

/**
 * Tools a read-only worker may receive. Keeping this explicit makes the
 * `read_only` scheduling promise enforceable instead of relying on its prompt.
 * Network and shell tools stay out because they can have external side effects.
 */
export const READ_ONLY_AGENT_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
]);
