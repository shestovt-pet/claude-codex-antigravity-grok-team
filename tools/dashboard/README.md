# Мост — дерево дел (как Проводник)

Панель коллегии для человека. Навигация — **раскрываемое дерево** папок→детей, не доска карточек.

**Модель:** слева дерево дел (проект → разговоры → материалы), справа переписка.  
Технические коды на основных экранах **не показываются**.

## Запуск

```bat
cd C:\most\tools\dashboard
npm start
```

Открыть: **http://127.0.0.1:3847/**

1. Слева — **Мои дела** (дерево).
2. Нажмите ▶ у папки, например «Коллегия-хаб».
3. Выберите разговор в ветке — справа переписка.
4. «Новое сообщение» у выбранного дела: черновик → подтвердите → передайте помощнику.
5. **Служебное** — только проверка каналов/квот (не дом).

Слушает **127.0.0.1**. Порт: `MOST_DASH_PORT` (по умолчанию `3847`).  
Удалённый доступ — **отложен**.

## Консилиум TREE (2026-10-02)

См. `C:\most\works\collegium-hub\DISCUSSION-tree.md`.  
Согласовано Grok + Antigravity + Codex: **X = A + B lite + C + D** (Проводник).

Соответствие: дела most → папки; указания → вложенные разговоры; текст/ответ → панель переписки.

## API (кратко)

- `GET /api/tree` — дерево дел с детьми
- `GET /api/projects` / `:name` / `:name/chats/:id` — деталь и тред
- `POST /api/intents` (+ confirm / enqueue) — запись сообщений

## Smoke

```bat
npm run smoke
```

## Важно

- «Помощник закончил» ≠ «итог принят вами».
- Ключ подтверждения скрыт под «Нужен ключ…».

## Hour-9 (2026-10-02)

Консилиум: **R + S-lite** — рубрикатор Проводника в корне («В работе» / «Завершённые») и папка «Проверки моста» для SMOKE-разговоров.
См. `HOUR-9-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour9.md`.
Home = expandable tree; kanban/peer-cards не primary. Remote по-прежнему deferred.

## Hour-10 (2026-10-02)

Консилиум: **Q + E-lite** — под делом папка «Разговоры» (живые чаты как третий уровень Проводника) и E2E smoke: live-intent → узел в дереве → тред справа.
См. `HOUR-10-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour10.md`.
SMOKE по-прежнему в «Проверки моста». Home = nested Explorer tree. Remote deferred.

## Hour-11 (2026-10-02)

Консилиум: **H + B-lite** — на узком экране каталог выезжает кнопкой «Каталог» / «Закрыть каталог»; выбор дела, разговора или проверки закрывает панель и показывает содержание. Строки дерева удобнее нажимать пальцем; папки чуть яснее. Home по-прежнему как Проводник.
См. `HOUR-11-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour11.md`.
Remote deferred.

## Hour-12 (2026-10-02)

Консилиум: **C + S-lite** — под делом папка «Консилиум» по шагам (раундам) вместо плоских «Материалы»; клик по шагу открывает сводку с раскрываемыми блоками «Задача» и «Проверки» (и «Судья», если есть). Подписи шагов по-русски («Час 12», «Основной»). «Разговоры» и «Проверки моста» без изменений. Home = nested Explorer tree.
См. `HOUR-12-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour12.md`.
Remote deferred.


## Hour-13 (2026-10-02)

Консилиум: **E2E каскад** — проверка пути «В работе → Коллегия-хаб → Разговоры / Проверки моста / Консилиум → раунд → сводка справа»; закрыт блокер клика по раунду (атрибуты data-round-* в onSelect). Drawer «Каталог» жив.
См. `HOUR-13-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour13.md`.
Home = nested Explorer tree. Remote deferred.

## Hour-14 (2026-10-02)

Консилиум: **A-lite + E-lite** — под «Проверки моста» последние ~6 проверок на виду, остальные во вложенной папке «Ранее» (как в Проводнике). Число на папке — полное. Smoke: HOUR14 на вложенный архив; каскад HOUR10–13 без регрессии.
См. `HOUR-14-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour14.md`.
Home = nested Explorer tree. Remote deferred.

## Hour-15 (2026-10-02)

Консилиум: **D-lite** — под «Ранее» SMOKE сгруппированы по дням («2 октября», …), внутри — листы; верхние ~6 свежих SMOKE без изменений Hour-14. Smoke: HOUR15 day-group; status честный.
См. `HOUR-15-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour15.md`.
Home = nested Explorer tree. Remote deferred.

## Hour-usable (2026-10-03)

Usable loop (DISCUSSION-usable-flight X=B): literary check titles, «Новое дело» / «Новый разговор», status triad в работе/ждёт/готово, local comment persist. Remote deferred. See HOUR-usable.md.

## Hour-16 (2026-10-03)

Консилиум: **Q-lite + H-lite** — тестовые/посадочные дела убраны из корня «В работе» в папку «Пробы»; на узкой ширине — липкая полоса быстрых действий («Новое дело» / «Новый разговор» / «Сохранить комментарий»). Day-folders под «Ранее» отдают `label`. Smoke: HOUR16; каскад HOUR14/15/usable без регрессии.
См. `HOUR-16-CONSILIUM.md` и `C:\\most\\works\\collegium-hub\\DISCUSSION-hour16.md`.
Home = nested Explorer tree. Remote deferred.
Soft-next: handheld UI-walk polish или более глубокий C-lite.

