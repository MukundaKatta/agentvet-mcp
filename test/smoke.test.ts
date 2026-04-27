/**
 * End-to-end smoke test: spawn the MCP server, ask for the tool catalog, and call
 * each tool with a representative input. Validates wire-level shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, '..', 'src', 'server.ts');

function rpc(child: ReturnType<typeof spawn>, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if ('id' in msg && (msg as { id: number }).id === (request as { id: number }).id) {
            child.stdout?.off('data', onData);
            resolve(msg);
            return;
          }
        } catch {
          // partial line, keep buffering
        }
      }
    };
    child.stdout?.on('data', onData);
    child.on('error', reject);
    child.stdin?.write(JSON.stringify(request) + '\n');
  });
}

async function withServer(fn: (child: ReturnType<typeof spawn>) => Promise<void>) {
  const child = spawn('npx', ['tsx', SERVER], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  await rpc(child, {
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' },
    },
  });
  child.stdin?.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
  );
  try {
    await fn(child);
  } finally {
    child.kill();
  }
}

test('server lists three tools', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })) as { result: { tools: Array<{ name: string }> } };
    const names = res.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'generate_retry_message',
      'lint_tool_definition',
      'validate_tool_args',
    ]);
  });
});

test('validate_tool_args passes well-shaped args', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'validate_tool_args',
        arguments: {
          tool_name: 'send_email',
          args: { to: 'a@b.com', subject: 'hi', body: 'hello' },
          shape: { to: 'string', subject: 'string', body: 'string' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as { valid: boolean };
    assert.equal(payload.valid, true);
  });
});

test('validate_tool_args returns retry_hint on bad shape', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'validate_tool_args',
        arguments: {
          tool_name: 'send_email',
          args: { to: 'a@b.com' /* missing subject, body */ },
          shape: { to: 'string', subject: 'string', body: 'string' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      valid: boolean;
      error: string;
      retry_hint: string;
    };
    assert.equal(payload.valid, false);
    assert.ok(payload.error.length > 0);
    assert.ok(payload.retry_hint.length > 0);
  });
});

test('lint_tool_definition flags missing description and required fields', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'lint_tool_definition',
        arguments: {
          tool: {
            name: 'BadName', // not snake_case
            inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
            // no description, no required
          },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as {
      ok: boolean;
      warnings: string[];
    };
    assert.equal(payload.ok, false);
    assert.ok(payload.warnings.some((w) => w.includes('snake_case')));
    assert.ok(payload.warnings.some((w) => w.includes('description')));
    assert.ok(payload.warnings.some((w) => w.includes('required')));
  });
});

test('generate_retry_message returns a non-empty feedback string', async () => {
  await withServer(async (child) => {
    const res = (await rpc(child, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'generate_retry_message',
        arguments: {
          tool_name: 'send_email',
          validation_error: 'missing required field: subject',
          attempted_args: { to: 'a@b.com' },
        },
      },
    })) as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(res.result.content[0]!.text) as { retry_message: string };
    assert.ok(payload.retry_message.length > 0);
    assert.ok(payload.retry_message.includes('send_email'));
  });
});
