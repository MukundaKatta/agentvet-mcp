#!/usr/bin/env node
/**
 * agentvet MCP server.
 *
 * Three tools that wrap @mukundakatta/agentvet's validation primitives:
 *
 *   validate_tool_args     — check args against a shape spec, return error + retry hint
 *   lint_tool_definition   — sanity-check a tool definition for completeness
 *   generate_retry_message — build the LLM-facing retry feedback string
 *
 * Configure your client to spawn this binary over stdio. Example for Claude Desktop's
 * `claude_desktop_config.json`:
 *
 *   {
 *     "mcpServers": {
 *       "agentvet": {
 *         "command": "npx",
 *         "args": ["-y", "@mukundakatta/agentvet-mcp"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { validate, adapters, ToolArgError, VERSION } from '@mukundakatta/agentvet';

const server = new Server(
  {
    name: 'agentvet',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- tool catalog ---------------------------------------------------------

const SHAPE_SCHEMA = {
  type: 'object',
  description:
    'Shape spec mapping field name to type. Types: "string", "number", "boolean", "array", "object". Suffix with "?" for optional. Example: { "name": "string", "age": "number", "tags": "array", "notes": "string?" }',
  additionalProperties: { type: 'string' },
} as const;

const TOOLS = [
  {
    name: 'validate_tool_args',
    description:
      'Validate a tool-call args object against a small shape spec. Returns { valid, error?, retry_hint? } where retry_hint is a ready-to-send LLM feedback message describing exactly what was wrong.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description: 'Name of the tool being called (surfaces in retry_hint).',
        },
        args: {
          type: 'object',
          description: 'The args object the LLM wants to pass.',
        },
        shape: SHAPE_SCHEMA,
      },
      required: ['tool_name', 'args', 'shape'],
    },
  },
  {
    name: 'lint_tool_definition',
    description:
      'Sanity-check a tool definition for common mistakes that hurt LLM tool-use accuracy: missing description, vague description, no required fields, schema fields without descriptions, non-snake_case names.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'object',
          description: 'A tool definition: { name, description, inputSchema }.',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            inputSchema: { type: 'object' },
          },
          required: ['name'],
        },
      },
      required: ['tool'],
    },
  },
  {
    name: 'generate_retry_message',
    description:
      'Given a tool name, validation error, and attempted args, build the canonical LLM-facing retry feedback message. Uses agentvet\'s ToolArgError.toLLMFeedback() formatting so the wording matches what runtime callers see.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        validation_error: { type: 'string' },
        attempted_args: { type: 'object' },
      },
      required: ['tool_name', 'validation_error', 'attempted_args'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// --- tool dispatch --------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    switch (name) {
      case 'validate_tool_args':
        return validateToolArgsTool(args as { tool_name: string; args: any; shape: any });
      case 'lint_tool_definition':
        return lintToolDefinitionTool(args as { tool: any });
      case 'generate_retry_message':
        return generateRetryMessageTool(args as { tool_name: string; validation_error: string; attempted_args: any });
      default:
        return errorResult('unknown tool: ' + name);
    }
  } catch (err) {
    return errorResult('internal error: ' + (err as Error).message);
  }
});

// --- tool implementations -------------------------------------------------

function validateToolArgsTool(input: { tool_name: string; args: any; shape: any }) {
  const validator = adapters.shape(input.shape);
  const result = validate(input.tool_name, validator, input.args);
  if (result.valid) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ valid: true }, null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            valid: false,
            error: result.error.validationError,
            retry_hint: result.error.toLLMFeedback?.() ?? result.error.message,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function lintToolDefinitionTool(input: { tool: any }) {
  const t = input.tool ?? {};
  const warnings: string[] = [];

  if (!t.name) {
    warnings.push('missing name');
  } else if (!/^[a-z][a-z0-9_]*$/.test(t.name)) {
    warnings.push(`name "${t.name}" should be snake_case (lowercase, digits, underscores; starts with a letter)`);
  }

  if (!t.description) {
    warnings.push('missing description — LLMs rely on this to pick the right tool');
  } else if (t.description.length < 20) {
    warnings.push('description is very short — consider expanding what the tool does, when to use it, and any preconditions');
  } else if (/^(does stuff|misc|util|helper)$/i.test(t.description.trim())) {
    warnings.push('description is too vague to be useful');
  }

  const schema = t.inputSchema;
  if (!schema) {
    warnings.push('missing inputSchema — tool calls will not be validated');
  } else {
    if (schema.type !== 'object') {
      warnings.push('inputSchema.type should be "object" for MCP tool inputs');
    }
    if (!schema.properties || Object.keys(schema.properties).length === 0) {
      warnings.push('inputSchema has no properties — accepts arbitrary input');
    } else {
      for (const [field, spec] of Object.entries(schema.properties as Record<string, any>)) {
        if (!spec || typeof spec !== 'object') continue;
        if (!spec.description) {
          warnings.push(`schema.${field}: missing field description (LLMs use this to pick correct values)`);
        }
      }
    }
    if (!schema.required || (Array.isArray(schema.required) && schema.required.length === 0)) {
      warnings.push('inputSchema has no required fields — every call is "valid" and validation cannot help');
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: warnings.length === 0, warnings }, null, 2),
      },
    ],
  };
}

function generateRetryMessageTool(input: { tool_name: string; validation_error: string; attempted_args: any }) {
  const err = new ToolArgError(input.tool_name, input.validation_error, input.attempted_args);
  const feedback = err.toLLMFeedback?.() ?? err.message;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ retry_message: feedback }, null, 2),
      },
    ],
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

// --- bootstrap ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(`agentvet MCP server v0.1.0 (agentvet ${VERSION}) ready on stdio\n`);
