'use strict';
const { Team } = require('../common/team');
process.on('message', async (a) => {
  try {
    const t = new Team(a.root, a.state);
    const result = await t[a.method](a.args);
    process.send({ ok: true, result });
  } catch (e) {
    process.send({ ok: false, error: e.message });
  } finally {
    process.disconnect();
  }
});
process.send({ ready: true });
