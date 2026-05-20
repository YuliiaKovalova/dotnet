// Script that communicates with binlog-mcp via MCP stdio protocol to extract build errors.
// Adapted from microsoft/testfx PR #8326 for use in dotnet/dotnet (VMR).
// Supports being called multiple times for different binlogs; results are merged upstream.

const path = require('path');
const fs = require('fs');

const binlogPath = process.argv[2];
if (!binlogPath) {
  console.error('Usage: node extract-binlog-errors.js <binlog-path>');
  process.exit(1);
}

if (!fs.existsSync(binlogPath)) {
  console.error(`Binlog not found: ${binlogPath}`);
  process.exit(1);
}

const absolutePath = path.resolve(binlogPath);

async function main() {
  let client;
  let failed = false;

  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: 'binlog-mcp',
      args: [],
    });

    client = new Client({ name: 'binlog-analyzer', version: '1.0.0' });
    await client.connect(transport);

    const overview = await client.callTool({
      name: 'binlog_overview',
      arguments: { binlog_file: absolutePath },
    });

    const errors = await client.callTool({
      name: 'binlog_errors',
      arguments: { binlog_file: absolutePath },
    });

    const warnings = await client.callTool({
      name: 'binlog_warnings',
      arguments: { binlog_file: absolutePath, top: 10 },
    });

    const errorsText = extractText(errors);
    let errorsJson = errorsText;
    try { JSON.parse(errorsText); } catch {
      errorsJson = JSON.stringify([{ severity: 'error', message: errorsText }]);
    }

    const result = {
      overview: extractText(overview),
      errors: errorsJson,
      warnings: extractText(warnings),
      binlogFile: path.basename(absolutePath),
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    const errorMessage = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(`Error: ${errorMessage}`);
    failed = true;
  } finally {
    try { if (client) await client.close(); } catch {}
  }

  process.exitCode = failed ? 1 : 0;
}

function extractText(response) {
  if (response?.content) {
    return response.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return 'No data';
}

main();
