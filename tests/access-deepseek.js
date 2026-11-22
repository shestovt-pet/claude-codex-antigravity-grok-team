'use strict';
// team-v58: чат любого зарегистрированного участника (в т.ч. семьи только для чтения deepseek) получает полный набор
// дирижёра — в чате может быть пользователь. Роль семьи (sends=false) ограничивает её как исполнителя/голос, но не чат.
// Признак поручения (jobSession) отсекает исполнителя; неизвестный клиент по-прежнему без инструментов.
const assert = require('assert');
const { run } = require('./team-v16-fixture');
const access = require('../common/access');
const { family } = require('../common/model-family');

// Клиент на время проверки; прежнее значение возвращается как было.
function withClient(c, fn) {
  const before = process.env.MOST_CLIENT;
  process.env.MOST_CLIENT = c;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.MOST_CLIENT;
    else process.env.MOST_CLIENT = before;
  }
}

// team-v58: полный набор дирижёра для чата участника. team — все девять инструментов; серверы участников —
// status/send/result/cancel (+ antigravity_apply).
const FULL = {
  team: ['team_status', 'team_rules', 'team_members', 'team_change', 'team_word', 'team_work', 'team_inbox', 'team_ask', 'team_ask_result', 'team_scenario'],
  codex: ['codex_status', 'codex_send', 'codex_result', 'codex_cancel'],
  antigravity: ['antigravity_status', 'antigravity_send', 'antigravity_result', 'antigravity_apply', 'antigravity_cancel'],
};

run([
  ['П1: неизвестный клиент не получает инструментов', () => {
    withClient('zzz', () => {
      assert.deepEqual(access.guestTools('team', 'zzz'), []);
      assert.deepEqual(access.guestTools('codex', 'zzz'), []);
      assert.equal(access.allowed('team', 'team_status'), false);
    });
  }],
  ['П2: deepseek-чат получает полный набор дирижёра (team-v58)', () => {
    withClient('deepseek', () => {
      assert.equal(access.client(), 'deepseek');
      assert.equal(access.guest(), true);       // роль семьи — не дирижёр, но это чат участника
      assert.equal(access.chatSession(), true);
      assert.equal(access.jobSession(), false);
      for (const s of Object.keys(FULL)) {
        assert.deepEqual(access.guestTools(s, 'deepseek'), FULL[s], 'набор для сервера ' + s);
        for (const t of FULL[s]) assert.equal(access.allowed(s, t), true, 'разрешено ' + t);
      }
      // team-v58: team_word, team_change, *_send теперь в наборе чата участника.
      assert.equal(access.allowed('team', 'team_word'), true);
      assert.equal(access.allowed('team', 'team_change'), true);
      assert.equal(access.allowed('team', 'team_members'), true);
      assert.equal(access.allowed('codex', 'codex_send'), true);
      assert.equal(access.allowed('antigravity', 'antigravity_send'), true);
    });
  }],
  ['П3: deepseek-чат ведёт team_change (все действия), пишет в работы, открывает диагностику (team-v58)', () => {
    withClient('deepseek', () => {
      // team-v58: прочие действия team_change больше не закрываются гостю — чат ведёт полное управление (merge/start/deploy).
      assert.doesNotThrow(() => access.guard('team', 'team_change', { action: 'merge' }), 'team_change merge открыт чату');
      assert.doesNotThrow(() => access.guard('team', 'team_change', { action: 'deploy' }), 'team_change deploy открыт чату');
      assert.doesNotThrow(() => access.guard('team', 'team_change', { action: 'start' }), 'team_change start открыт чату');
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'update' }), 'team_work открыт');
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'create' }));
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'list' }));
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'get' }));
      assert.doesNotThrow(() => access.guard('team', 'team_status', {}));
      // team-v58: диагностика team_status (quota/usage) открыта чату участника.
      assert.doesNotThrow(() => access.guard('team', 'team_status', { claude_quota: true }), 'диагностика quota открыта чату');
      assert.doesNotThrow(() => access.guard('team', 'team_status', { claude_usage: true }), 'диагностика usage открыта чату');
    });
  }],
  ['П2б (04be41a §2.2/4e): Claude-исполнитель (claude-print) отменяет codex/deepseek/antigravity-потомков, свой сервер claude — нет', () => {
    // Вне поручения-сеанса: claude-print разрешается в участника claude (без MOST_JOB_ID, иначе ищется карточка поручения).
    const prevJob = process.env.MOST_JOB_ID; delete process.env.MOST_JOB_ID;
    try {
      withClient('claude-print', () => {
        // claude-print отменяет своих потомков на серверах-пирах через *_cancel (регистрируется в guestTools).
        assert(access.guestTools('codex', 'claude-print').includes('codex_cancel'), 'claude-print→codex_cancel зарегистрирован');
        assert(access.guestTools('deepseek', 'claude-print').includes('deepseek_cancel'), 'claude-print→deepseek_cancel зарегистрирован');
        assert(access.guestTools('antigravity', 'claude-print').includes('antigravity_cancel'), 'claude-print→antigravity_cancel зарегистрирован');
        // Свой сервер claude исключён: своих claude-потомков нет (claude→claude ловит lineageRefusal), claude_cancel НЕ выдаётся.
        assert(!access.guestTools('claude', 'claude-print').includes('claude_cancel'), 'claude-print→claude_cancel НЕ зарегистрирован');
      });
    } finally { if (prevJob === undefined) delete process.env.MOST_JOB_ID; else process.env.MOST_JOB_ID = prevJob; }
  }],
  ['П4: старый путь пробы (legacy) у deepseek тоже только чтение', () => {
    withClient('deepseek', () => {
      process.env.MOST_PROBE_ONLY = '1';
      delete process.env.MOST_PROBE_GUEST;
      try {
        assert.equal(access.allowed('team', 'team_status'), true);
        assert.equal(access.allowed('team', 'team_work'), true);
        assert.equal(access.allowed('codex', 'codex_status'), true);
        assert.equal(access.allowed('codex', 'codex_result'), true);
        assert.equal(access.allowed('codex', 'codex_send'), false);
        assert.equal(access.allowed('antigravity', 'antigravity_send'), false);
      } finally {
        delete process.env.MOST_PROBE_ONLY;
      }
    });
  }],
  ['П5: наборы codex и antigravity на team — полный набор дирижёра (team-v58); серверы семьи получают cancel/apply', () => {
    withClient('codex', () => {
      assert.deepEqual(access.guestTools('team', 'codex'), FULL.team);
      assert.deepEqual(access.guestTools('antigravity', 'codex'), FULL.antigravity);
      assert.deepEqual(access.guestTools('codex', 'codex'), FULL.codex);
    });
    withClient('antigravity', () => {
      assert.deepEqual(access.guestTools('team', 'antigravity'), FULL.team);
    });
    withClient('claude', () => {
      assert.equal(access.guest(), false);
      assert.equal(access.allowed('team', 'team_work'), true);
    });
  }],
  ['П6: семья deepseek распознаётся по имени модели, неизвестное — null', () => {
    assert.equal(family('deepseek-flash'), 'deepseek');
    assert.equal(family('DeepSeek-V3'), 'deepseek');
    assert.equal(family('gpt-6-astra'), 'openai');
    assert.equal(family('claude-sonnet-4.6'), 'anthropic');
    assert.equal(family('zzz-1'), null);
  }],
]);
