# Публикация на GitHub и обновление публичной копии

Порядок принят в team-v11 (Р4) и team-v12 (Р6). Выполняет Grok своим Shell на компьютере пользователя, Claude
сверяет выводы. Публикация — действие вне папок автоодобрения: Grok Bot попросит подтверждение, поэтому поручение
отправляется, когда пользователь у экрана (rules/claude.md, «Подтверждения Grok Bot и публикация»).

Частные строки для обезличивания лежат только в `state\public-export.json` (не в git):
`{ "userFolder": "<папка в C:\Users>", "replace": [["было", "стало"], …], "forbidden": ["строка", …], "allow": [] }`.
В ответах Grok пишет только номера запрещённых строк и числа совпадений, не сами строки.

## Первая публикация

1. `$w = Join-Path $env:TEMP ('most-publish-' + [guid]::NewGuid())`; в корне связки:
   `node tools/export-public.js "$w\repo"` (логин берётся из `gh api user`; `--holder`, если задан, должен совпасть).
2. В `"$w\repo"`: `git init -b main`, `git add -A -f .` (с `-f`: в выгрузке только публикуемые файлы, а
   отслеживаемый исходник `tests/.tmp-v6-restart-parse.ps1` подпадает под `.gitignore`), проверка состава —
   `git ls-files` совпадает со списком всех файлов выгрузки (кроме `.git`) один в один; коммит с автором и коммитером
   `<логин> <<id>+<логин>@users.noreply.github.com>` через `-c user.name/-c user.email -c commit.gpgsign=false`
   (глобальный git config не участвует); `git log -1 --format="%an <%ae> / %cn <%ce>"` — только noreply.
3. Поиск запрещённых строк: `git grep -i -F -c <строка> HEAD` и по `git ls-files` — все 0.
4. `git clone "$w\repo" "$w\check"`; там `npm ci`, `$env:MOST_AFTER_DEPLOY='off'`, `node tests/run.js` — 0 провалов.
5. Установка в изолированном профиле в `"$w\check"`, всё в одном процессе PowerShell:
   - убрать ВСЕ переменные MOST_* — среди них переопределения путей, которые важнее USERPROFILE и APPDATA
     (Env:MOST_CLAUDE_CONFIGS, Env:MOST_CODEX_CONFIG, Env:MOST_AGY_MCP_CONFIG, Env:MOST_AGY_CONFIG,
     Env:MOST_CODEX_RULES, Env:MOST_AGY_RULES, Env:MOST_REPO_ROOT, Env:MOST_STATE_DIR), и MOST_AFTER_DEPLOY из п. 4:
     `Get-ChildItem Env:MOST_* | ForEach-Object { Remove-Item "Env:$($_.Name)" }`;
   - `$p = "$w\profile"`; `$env:USERPROFILE=$p`; `$env:APPDATA="$p\AppData\Roaming"`; `$env:LOCALAPPDATA="$p\AppData\Local"`;
     `$env:MOST_SETUP_NOPAUSE='1'`; проверка `Get-ChildItem Env:MOST_*` — нет ничего, кроме MOST_SETUP_NOPAUSE,
     иначе остановка;
   - поддельные файлы всех трёх приложений, в каждом — «чужая» запись для проверки сохранности:
     `$p\AppData\Roaming\Claude\claude_desktop_config.json` = `{"mcpServers":{"other":{"command":"keep"}}}`;
     `$p\.codex\config.toml` = строка `# мой текст`;
     `$p\.gemini\config\mcp_config.json` = `{"mcpServers":{"mine":{"command":"keep"}}}`; `$p\.gemini\config\config.json` = `{}`;
   - `.\setup.cmd --dry-run`, `.\setup.cmd`, повтор `.\setup.cmd`. Ожидается: найдены и подключены Claude, Codex и
     Antigravity; записи `other`, `mine` и строка `# мой текст` сохранены; рядом с каждым файлом `.prev`; созданы
     `$p\.codex\AGENTS.md` и `$p\.gemini\config\AGENTS.md`; повтор — «раздел связки актуален»; строки DEP0190 нет;
     настоящие конфиги не меняются: до и после — `Test-Path`, и для существующих `(Get-Item <файл>).LastWriteTimeUtc`.
6. Только после этого: `gh repo view <логин>/<имя>` — репозитория нет; затем в `"$w\repo"`
   `gh repo create <логин>/<имя> --public --source . --remote origin --description "…"` — БЕЗ `--push`
   (его дочерний git push не получает `-c` и может открыть окно входа), затем явный push, как ниже.

Вход для push — только через gh, без окна входа git и без изменения глобального git config. PowerShell:
`git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main`; cmd:
`git -c credential.helper= -c "credential.helper=!gh auth git-credential" push origin main`. Голый `git push`
не использовать.
Клонирование публичного репозитория (`git clone`, `git clone --no-checkout`) — обычной командой без этого
префикса: вход не нужен. Если команда ждёт окно входа дольше минуты — остановить её и сообщить
(team-v12: первый push завис на git-credential-manager).
7. `git ls-remote https://github.com/<логин>/<имя>.git main` — тот же хеш; клон с GitHub — тот же хеш, поиск
   запрещённых строк — 0.

## Обновление опубликованной копии

1. Как в п. 1 выше, новая выгрузка в `"$w\repo"` из нового `main` (папка публикации).
2. История опубликованного репозитория — отдельной временной папкой, не в папку публикации:
   `git clone --no-checkout https://github.com/<логин>/<имя>.git "$w\pub"`; запомнить `$old = git -C "$w\pub" rev-parse HEAD`;
   перенести папку `"$w\pub\.git"` в `"$w\repo\.git"` (файлы выгрузки не меняются; в папке публикации до этого
   `.git` быть не должно — при повторной попытке начать с новой выгрузки), пустую `"$w\pub"` удалить.
3. В `"$w\repo"`: `git read-tree HEAD` (индекс — опубликованное дерево, рабочие файлы не трогаются), затем
   `git add -A -f .` — удалённые в новой версии файлы уходят, новые и изменённые попадают, в том числе
   подпадающие под `.gitignore`. Проверка: `git ls-files` совпадает со списком файлов выгрузки (относительные пути, без `.git`) один в один;
   `git status --short` — только ожидаемая разница.
4. Коммит noreply как в п. 2 первой публикации; проверка автора и коммитера; родитель нового коммита — `$old`.
5. Пп. 3–5 первой публикации (поиск запрещённых строк, прогон в клоне, установка в изолированном профиле).
   Любой провал — остановка, push не делается.
6. Push через gh, как выше (PowerShell: `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main`), без `--force`. Отклонён — ветка на GitHub сдвинулась после п. 2: остановиться и
   сообщить, ничего не перезаписывать.
7. `git ls-remote` и клон с GitHub — новый хеш, `HEAD^` = `$old`, поиск запрещённых строк — 0, состав файлов —
   как у выгрузки.

Опубликованные коммиты: 2e8a6260 (28.09.2026, team-v11, первая публикация; в неё не попал
`tests/.tmp-v6-restart-parse.ps1` — `git add -A` без `-f`, исправлено в порядке выше); 6016aa2d (28.09.2026,
team-v12, обновление 0.5.7).

Временные папки `$w` после сверки удаляются; оставить можно только по просьбе Claude для разбора сбоя.
