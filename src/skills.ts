// The MCP server the provider path serves omp's tools from, and the prefix
// Claude Code sees them under. Skills and rules reach Claude Code through the
// system prompt projection in omp-prompt.ts.

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
