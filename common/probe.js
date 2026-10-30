'use strict';
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
async function probe(file, env = process.env, timeout = 15000, { allowEmpty = false } = {}) {
  const client = new Client({ name: 'most_probe', version: '0.3.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [file], env, stderr: 'pipe' });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        // team-v33: сервер, на котором гостю не разрешён ни один инструмент, не объявляет tools,
        // и listTools отвечает MethodNotFound (-32601). Только для гостевой проверки (allowEmpty) это пустой список;
        // проба от имени Claude остаётся строгой (ревью Codex 8ac20262).
        try { return await client.listTools(); }
        catch (e) { if (allowEmpty && e && e.code === -32601) return { tools: [] }; throw e; }
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
