# HOWTO: fallback-дирижёр (фаза 1 / инкременты 1–4)

Установлено в `C:\most`. Host не трогает Desktop state; enter только с confirm и только в allowlist dirs.

## Status / List / Access

## Detect (advise only, инкремент detect)

Авто-enter/leave **запрещены**. Команда только советует:

```
C:\most\scripts\fallback.cmd detect
```

Сигналы enter: нет процесса Claude Desktop; мёртв `state/ready/team.json`; опционально `claude-quota.json` с `percent=0` (не журнал calls).  
Сигналы leave: процесс Claude жив + team ready жив + (желательно) очередь host jobs пуста.  
Agy/Codex quota ≠ подписка Claude Desktop — не триггерят Desktop fallback.

```
C:\most\scripts\fallback.cmd status
C:\most\scripts\fallback.cmd list
C:\most\scripts\fallback.cmd access-describe
```

`fallback.cmd` выставляет `MOST_FALLBACK_HUMAN=1` (человеческая сессия). Прямой вызов `node tools\host-fallback.js` агентом токен не получает.

## Confirm (инкремент 2)

```
C:\most\scripts\fallback.cmd confirm-request enter
C:\most\scripts\fallback.cmd confirm-reveal <id>
C:\most\scripts\fallback.cmd enter --confirm-id <id> --confirm-token <token>
```

Токен: одноразовый, action+generation[+targetHash], TTL 15м, atomic consume.
`jobs.stop` требует meta.who+id; `actions.apply` — hash содержимого proposal.
`leave` повышает generation — старые confirm недействительны.
`--fallback-dir` только под draft roots (не `C:\most\state` / `live`).

## Jobs

```
C:\most\scripts\fallback.cmd confirm-request jobs.enqueue --who codex
C:\most\scripts\fallback.cmd confirm-reveal <id>
C:\most\scripts\fallback.cmd jobs-enqueue --who codex --task "..." --confirm-id ... --confirm-token ...
C:\most\scripts\fallback.cmd jobs-list
C:\most\scripts\fallback.cmd confirm-request jobs.stop --who codex --id <jobId>
C:\most\scripts\fallback.cmd jobs-stop --who codex --id <jobId> --confirm-id ... --confirm-token ...
```

Kill PID только если он host-owned; иначе только cancel-marker.

## Actions (инкремент 3)

Блок `FALLBACK_ACTIONS_BEGIN/END`. Запрет who=claude / deploy / team_change / shell.
Tamper proposal после confirm → apply отказ.

## Access (инкремент 4)

`common/access.js`: пустой client → unknown; peer ≠ judge;
`MOST_CLIENT=claude` при `authority=user` остаётся guest. При обычном Desktop (`MOST_CLIENT=claude`, нет fallback-сессии) — полный gate как раньше (`ready`/`queued` на месте).

## Smoke (на установленном коде)

```
node C:\most\tests\fallback-smoke-incr2.js
node C:\most\tests\fallback-smoke-incr3.js
node C:\most\tests\fallback-smoke-incr4.js
node C:\most\tests\fallback-smoke-enterleave.js
```

Либо из черновика (модули уже те же): `node .work\_grok_fallback_conductor\impl\tests\smoke-*.js`

## Возврат к Claude

1. `fallback.cmd leave` (с confirm) — гасит host-owned процессы, generation++.
2. Сверка deploy-ops / jobs / частичных результатов.
3. Desktop продолжает на своём `live\<release>`; при необходимости reconcile — отдельная команда человека / Claude.

## Roles per-task (гибкие роли)

Не «навсегда Claude=дирижёр», а **на эту задачу**: кто оркестрирует / пишет / ревьюит / судья / кто offline.

```
C:\most\scripts\roles.cmd propose --work my-task --kind code
C:\most\scripts\roles.cmd get --work my-task
C:\most\scripts\roles.cmd confirm-request --work my-task
C:\most\scripts\roles.cmd confirm-reveal <id>
C:\most\scripts\roles.cmd confirm --work my-task --confirm-id <id> --confirm-token <token>
```

`--kind`: code | review | design | ops | fallback. Без `--slots` — эвристика + `fallback detect` (если Claude offline → orchestrator≠claude).
Подтверждает **только человек** (как enter/leave). Запись: `works/<work>/roles.json`.
Запреты: self-review; judge на ops/fallback = user; не подделывать who=claude.

Smoke: `node C:\most\tests\roles-smoke.js` и `node C:\most\tests\roles-e2e-confirm.js`.