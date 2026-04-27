# agentvet-mcp

**MCP server for [`@mukundakatta/agentvet`](https://www.npmjs.com/package/@mukundakatta/agentvet).** Lets Claude Desktop, Cursor, Cline, Windsurf, Zed, or any other MCP client validate LLM-generated tool-call args before execution and produce LLM-friendly retry messages when something's wrong.

```bash
npx -y @mukundakatta/agentvet-mcp
```

Three tools:

- **`validate_tool_args`** — check args against a small shape spec; returns `{ valid, error?, retry_hint? }` where `retry_hint` is a ready-to-send LLM feedback message.
- **`lint_tool_definition`** — sanity-check a tool definition for common mistakes that hurt LLM tool-use accuracy.
- **`generate_retry_message`** — given a validation error, build the canonical LLM-facing retry message using agentvet's `ToolArgError.toLLMFeedback()` formatting.

## Add to your client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "agentvet": {
      "command": "npx",
      "args": ["-y", "@mukundakatta/agentvet-mcp"]
    }
  }
}
```

Same shape for Cursor (`~/.cursor/mcp.json`), Cline, Windsurf, Zed.

## Tool examples

**`validate_tool_args`:**

```json
{
  "tool_name": "send_email",
  "args": { "to": "a@b.com" },
  "shape": { "to": "string", "subject": "string", "body": "string" }
}
```

Returns:

```json
{
  "valid": false,
  "error": "missing required field: subject",
  "retry_hint": "send_email rejected your args: missing required field: subject. Please call again with the corrected arguments."
}
```

**`lint_tool_definition`:**

```json
{
  "tool": {
    "name": "BadName",
    "inputSchema": { "type": "object", "properties": { "x": { "type": "string" } } }
  }
}
```

Returns warnings about non-snake_case name, missing description, missing field descriptions, and no required fields.

**`generate_retry_message`:**

```json
{
  "tool_name": "send_email",
  "validation_error": "missing required field: subject",
  "attempted_args": { "to": "a@b.com" }
}
```

Returns the canonical retry feedback string the runtime callers see — so you can prepare retry text outside the live agent loop.

## Why a separate MCP server

`@mukundakatta/agentvet` is a zero-dependency JavaScript library. This MCP server makes its validation primitives accessible from any MCP-aware AI assistant. Useful for quickly auditing a registry of tools, or asking the assistant "is this args object valid for my `send_email` tool?" without leaving the chat.

For runtime arg validation in your agent loop, use `@mukundakatta/agentvet` directly inside your Node process (it wraps your tool fn and throws `ToolArgError` synchronously).

## Sibling MCP servers

Part of the agent-stack series:

- [`@mukundakatta/agentfit-mcp`](https://www.npmjs.com/package/@mukundakatta/agentfit-mcp) — *Fit it.*
- [`@mukundakatta/agentguard-mcp`](https://www.npmjs.com/package/@mukundakatta/agentguard-mcp) — *Sandbox it.*
- [`@mukundakatta/agentsnap-mcp`](https://www.npmjs.com/package/@mukundakatta/agentsnap-mcp) — *Test it.*
- [`@mukundakatta/agentvet-mcp`](https://www.npmjs.com/package/@mukundakatta/agentvet-mcp) — *Vet it.* (this)
- [`@mukundakatta/agentcast-mcp`](https://www.npmjs.com/package/@mukundakatta/agentcast-mcp) — *Validate it.*

## License

MIT
