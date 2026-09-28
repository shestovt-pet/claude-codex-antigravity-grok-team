'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
async function probe(file, env = process.env, timeout = 15000) {
  const client = new Client({ name: 'most_probe', version: '0.3.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], env, stderr: 'pipe' });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        return await client.listTools();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Пробный запуск не завершился вовремя.')), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.close();
    await transport.close();
  }
}
module.exports = { probe };
