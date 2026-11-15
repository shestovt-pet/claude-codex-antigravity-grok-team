'use strict';
// Внешняя семья deepseek (вводная от 20.10.2026, вариант B): гость только для чтения —
// ни поручений (*_send), ни записи в работы, ни голоса в воротах. Неизвестный клиент по-прежнему без инструментов.
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

const READ_ONLY = {
  team: ['team_status', 'team_rules', 'team_work'],
  codex: ['codex_status', 'codex_result'],
  antigravity: ['antigravity_status', 'antigravity_result'],
};

run([
  ['П1: неизвестный клиент не получает инструментов', () => {
    withClient('zzz', () => {
      assert.deepEqual(access.guestTools('team', 'zzz'), []);
      assert.deepEqual(access.guestTools('codex', 'zzz'), []);
      assert.equal(access.allowed('team', 'team_status'), false);
    });
  }],
  ['П2: deepseek — гость с набором только для чтения', () => {
    withClient('deepseek', () => {
      assert.equal(access.client(), 'deepseek');
      assert.equal(access.guest(), true);
      for (const s of Object.keys(READ_ONLY)) {
        assert.deepEqual(access.guestTools(s, 'deepseek'), READ_ONLY[s], 'набор для сервера ' + s);
        for (const t of READ_ONLY[s]) {
          assert(!/_send$/.test(t), 'deepseek не должен получать ' + t);
          assert.equal(access.allowed(s, t), true, 'разрешено ' + t);
        }
      }
      assert.equal(access.allowed('codex', 'codex_send'), false);
      assert.equal(access.allowed('antigravity', 'antigravity_send'), false);
      assert.equal(access.allowed('team', 'team_word'), false);
      assert.equal(access.allowed('team', 'team_change'), false);
    });
  }],
  ['П3: deepseek (только чтение) не ставит поручения, не пишет и не воротит изменение связки; team_work открыт безусловно', () => {
    withClient('deepseek', () => {
      assert.throws(() => access.guard('team', 'team_change', { action: 'merge' }), /запрещено/);
      // team-v48e Г4b: team_work-изменение гостю открыто безусловно (тумблер MOST_GUEST_STRICT удалён).
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'update' }), 'team_work открыт');
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'create' }));
      // deepseek — семья только для чтения (roles.sends=false): *_send недоступны (нет в guestTools), а не из-за тумблера.
      assert.throws(() => access.guard('codex', 'codex_send', { write: true }), /запрещено/);
      assert.throws(() => access.guard('codex', 'codex_send', { role: 'совет' }), /запрещено/);
      assert.throws(() => access.guard('antigravity', 'antigravity_send', { task: 't' }), /запрещено/);
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'list' }));
      assert.doesNotThrow(() => access.guard('team', 'team_work', { action: 'get' }));
      assert.doesNotThrow(() => access.guard('team', 'team_status', {}));
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
  ['П5: наборы codex и antigravity не изменились', () => {
    withClient('codex', () => {
      assert.deepEqual(access.guestTools('team', 'codex'), ['team_status', 'team_rules', 'team_work', 'team_ask', 'team_ask_result', 'team_word']);
      assert.deepEqual(access.guestTools('antigravity', 'codex'), ['antigravity_status', 'antigravity_send', 'antigravity_result', 'antigravity_apply']);
      assert.deepEqual(access.guestTools('codex', 'codex'), ['codex_status', 'codex_send', 'codex_result', 'codex_cancel']);
    });
    withClient('antigravity', () => {
      assert.deepEqual(access.guestTools('team', 'antigravity'), ['team_status', 'team_rules', 'team_work', 'team_ask', 'team_ask_result', 'team_word']);
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
