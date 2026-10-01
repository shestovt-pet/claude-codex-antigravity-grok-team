# Handoff: штатный fallback-дирижёр (инкременты 1–4)

Дата: 2026-10-01 (Asia/Nicosia). Автор установки: Grok Bot по явной команде человека «ставь и проверяй…».

## Зачем

Claude Desktop — единая точка отказа для gate (`team_change`, очереди исполнителей). Если Desktop закрыт/завис, команда не должна останавливаться и **не должна** подделывать `who=claude` или подставлять `MOST_CLIENT=claude` для обхода access.

Нужен штатный режим: **по умолчанию Claude; без него — fallback под судьёй-человеком**, с отдельным host-процессом и изолированным state.

## Что сделано

Установлено в дерево `C:\most` (не в `live\<release>` — Desktop не перезапускался):

| Путь | Назначение |
|---|---|
| `rules/fallback.md` | Правила режима; `team_rules part=fallback` после commit |
| `docs/HOWTO-fallback.md` | Команды enter/leave/confirm/jobs/actions |
| `scripts/fallback.cmd` | Человеческий вход: `MOST_FALLBACK_HUMAN=1` |
| `tools/host-fallback.js` | Host enter/leave/status/list/confirm/jobs/actions (INCREMENT=4) |
| `common/user-confirm.js` | Одноразовый confirm-токен (TTL 15м), atomic consume |
| `common/proposed-actions.js` | Блок FALLBACK_ACTIONS_*; whitelist; запрет who=claude |
| `common/access.js` | client≠authority; peer≠judge; `ready`/`queued` сохранены |
| `common/team.js` + `servers/team/index.js` | часть правил `fallback` в enum |
| `AGENTS.md` | Кратко: Claude по умолчанию, иначе fallback |
| `tests/fallback-smoke-*.js` | Smoke на установленном коде |

Черновик/дизайн: `C:\most\.work\_grok_fallback_conductor\` (`design.md`, `impl/`, `discuss/`). Зеркало: `C:\test-most\fallback-conductor\`.

## Роли в fallback

- **Человек** — единственный судья gate (`authority=user`); confirm-reveal только через `fallback.cmd`.
- **Host** — поднимает team/codex/antigravity/grok на **изолированном** state (`MOST_CLIENT=codex` guest), enqueue/stop, apply whitelist.
- **Grok** — proposals (структурированный блок); текст **не** shell.
- **Codex / Antigravity** — обязательные ревьюеры; не судьи gate.
- **Claude** — дирижёр, когда Desktop жив и нет fallback-сессии (`MOST_CLIENT=claude`).

## Как детектировать / входить / выходить

`state/ready/*.json` — отметки запуска, **не** heartbeat. Auto-failover **запрещён**.

Вход (человек):

```
C:\most\scripts\fallback.cmd confirm-request enter
C:\most\scripts\fallback.cmd confirm-reveal <id>
C:\most\scripts\fallback.cmd enter --confirm-id <id> --confirm-token <token>
```

Выход:

```
C:\most\scripts\fallback.cmd confirm-request leave
C:\most\scripts\fallback.cmd confirm-reveal <id>
C:\most\scripts\fallback.cmd leave --confirm-id <id> --confirm-token <token>
```

State host: `C:\most\.work\_grok_fallback_conductor\state` (и `state-smoke` для тестов).  
`C:\most\state` / `live` / `rules` как `--fallback-dir` **отклоняются**.

## access.js: что изменилось и что нет

Изменилось:

- Пустой `MOST_CLIENT` при **активной** fallback-сессии (`authority=user`) → `unknown` (гость), не подделка Claude.
- Вне fallback пустой `MOST_CLIENT` по-прежнему → `claude` (совместимость Desktop/тестов).
- `MOST_CLIENT=claude` + `authority=user` → всё ещё guest; `team_change`/deploy через MCP в этом режиме запрещены.
- `MOST_AUTHORITY` не перебивает session `authority=user`.
- Peer (grok/codex/antigravity/unknown) не может быть gate judge.

Не менялось для живого Claude:

- При `MOST_CLIENT=claude` и отсутствии fallback-сессии — полный gate как раньше.
- `ready(server)` и `queued` на месте (гость не пишет ready).
- Русское сообщение отказа гостю сохранено (тесты `/Гостю/`).
- **Работающий Desktop** на момент установки: release `b03e0f953fa21bf5d085d78300ec4518a673e496`, pid из `state/ready` — **не** убивался; redeploy не делался. Source tree опережает live; MCP Claude продолжает читать `live\b03e0f953fa21bf5d085d78300ec4518a673e496\`.

## Как тестировали

1. Smoke на установленном коде: `fallback-smoke-incr2/3/4` + `enterleave` — ok; Desktop ready не тронут.
2. Полный `node tests/run.js`: **649 успешно, 0 провалов, 4 пропуска** (после фикса empty-client вне fallback).
3. Первый прогон до фикса: 83 провала из-за empty→unknown глобально — исправлено сохранением historic default вне fallback.

## SHA / ссылки

- Локальный `C:\most` до publish-commit этой установки: было `a146e868bac7782a8aa018433ba0e710864088b4` (Н12 поверх team-v14).
- GitHub `main` на старте установки: `32bb286e722c1c3287473c6255d3bd57788d65f7`.
- Deployed live: `b03e0f953fa21bf5d085d78300ec4518a673e496` (C:\most\live\b03e0f953fa21bf5d085d78300ec4518a673e496).
- Дизайн: `.work/_grok_fallback_conductor/design.md`.
- HOWTO: `docs/HOWTO-fallback.md`.
- Репозиторий: https://github.com/shestovt-pet/claude-codex-antigravity-grok-team

GitHub push: fd9797fb90e3f7366298e0c25673045ea71f87b3 — https://github.com/shestovt-pet/claude-codex-antigravity-grok-team/commit/fd9797fb90e3f7366298e0c25673045ea71f87b3

## Что Claude сделать при возврате (reconcile)

1. Убедиться, что fallback leave выполнен (generation++, host-owned PID мертвы) — `fallback.cmd status`.
2. Сверить `state/deploy-ops`, jobs, частичные результаты host-state vs боевой `C:\most\state` — **не** ресендить running jobs вслепую.
3. Чтение get/list не должно продлевать heartbeat владельца.
4. Если нужен новый access.js/rules в живом MCP — обычный `team_change` → commit → deploy (это уже снова Claude-gate). До deploy Desktop продолжает старый live access.
5. Принять/отклонить замечания ревью по фактам; autodeploy fallback host в shared state не делать.

## Риски (оставшиеся)

1. Split-brain: два host / Desktop+host на одном state — path allowlist снижает, не исключает людскую ошибку.
2. Source vs live drift: access/rules в `C:\most` уже новые, `live\b03e0f953fa21bf5d085d78300ec4518a673e496` — старые до redeploy.
3. Confirm-токены: агентам нельзя `MOST_FALLBACK_HUMAN` и чтение `.token`; утечка с человеческой машины всё ещё риск.
4. Codex review incr2–4 имел блокеры stopSupervisor; в коде закрыты owned-markers + session в allDead — повторный независимый ревью после install желателен.
5. `team_rules part=fallback` читает **закоммиченный** main; до commit/export файла в git — «в main нет».

## Команды (кратко)

```
C:\most\scripts\fallback.cmd status
C:\most\scripts\fallback.cmd access-describe
node C:\most\tests\fallback-smoke-incr4.js
node C:\most\tests\run.js
```

Webhook secrets и содержимое `state/grok-webhook.json` в этот бриф **не** включались.

## Roles per-task (incr1)

Гибкие роли на задачу: `scripts/roles.cmd propose|get|confirm-*`. Артефакт `works/<work>/roles.json`. Confirm только человек (`roles.confirm`). Модуль `common/task-roles.js`. См. HOWTO § Roles и `.work/_grok_flexible_roles/design.md`.