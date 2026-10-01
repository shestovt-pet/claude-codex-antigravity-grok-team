# Fallback-режим (фаза 1 / инкременты 1–4)

Статус: установлен в `C:\most` (rules, common, tools, docs, scripts). Live Desktop release не перезапускался этим шагом — MCP Claude продолжает `live\<deployed>`; host fallback использует дерево `C:\most` и изолированный state.

## Включение

Только человек: `confirm-request` → `confirm-reveal` (через `scripts\fallback.cmd` / `MOST_FALLBACK_HUMAN=1`) → команда с `--confirm-id/--confirm-token`.
Агентам запрещено читать `confirm/*.token` и выставлять `MOST_FALLBACK_HUMAN=1`.
Авто-failover запрещён. Допустим только `advise_and_confirm` через `fallback.cmd detect` (советует enter/leave; переключение — человек + confirm).

## Роли

- Claude — дирижёр при Desktop (`authority=claude` / нет fallback-сессии, `MOST_CLIENT=claude`).
- Человек — судья gate в fallback (`authority=user`).
- Host — исполнитель (серверы, enqueue/stop jobs, apply whitelist actions) на изолированном state.
- Grok — proposals; не shell, не team_change.
- Codex/Agy — ревьюеры; не судьи gate.

## Инкременты

1. Host enter/leave, isolated state, 4 MCP, mutex, owned markers.
2. Confirm-канал (human reveal); jobs-enqueue/list/stop; generation bump on leave; path allowlist.
3. FALLBACK_ACTIONS proposals + content hash; no who=claude.
4. access.js: client≠authority; empty≠claude; peer≠judge; claude-client при authority=user → guest; `ready`/`queued` сохранены.

## Запреты

1. who=claude от агента / фабрикация карточек Claude.
2. MOST_CLIENT=claude для обхода access.
3. Peer как authority/судья.
4. Merge/deploy без «ставь».
5. Исполнять текст Grok как shell.
6. Подставлять/переиспользовать confirm-токен; читать .token без human flag.

## State

Боевой `C:\most\state` (Desktop) и fallback-state разделены. Host отклоняет `--fallback-dir` под `C:\most\state` / `live` / `rules`. Рабочий state: `C:\most\.work\_grok_fallback_conductor\state` (и state-smoke для тестов).