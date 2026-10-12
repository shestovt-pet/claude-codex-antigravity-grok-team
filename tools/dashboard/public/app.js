"use strict";
/* MOST dashboard — Explorer tree (DISCUSSION-tree) */

const state = {
  tree: null,
  expanded: new Set(),
  selected: null, // { kind, projectId, chatId?, material? }
  projectId: null,
  chatId: null,
  chat: null,
  project: null,
  lastTreeOkAt: null, // Hour-20: last successful tree refresh
};

function $(id) { return document.getElementById(id); }

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.error || data.message)) || ("Ошибка " + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Nicosia" });
  } catch { return ""; }
}

/* Hour-20: calm Russian hub health chip + last tree refresh */
function formatWhenRu(iso) {
  if (!iso) return "";
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
  ];
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Nicosia",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t) => (parts.find((x) => x.type === t) || {}).value || "";
  const dayNum = parseInt(get("day"), 10);
  const monthIdx = parseInt(get("month"), 10) - 1;
  const hh = get("hour");
  const mm = get("minute");
  if (!dayNum || monthIdx < 0 || monthIdx > 11) return "";
  return dayNum + " " + MONTHS[monthIdx] + ", " + hh + ":" + mm;
}

/* Hour-21: calm freshness label */
function freshnessLabelRu(iso) {
  const d = (iso instanceof Date) ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const agoMs = Date.now() - d.getTime();
  if (agoMs < 0) return formatWhenRu(d);
  if (agoMs < 90 * 1000) return "только что";
  if (agoMs < 60 * 60 * 1000) {
    const mins = Math.max(1, Math.round(agoMs / 60000));
    if (mins === 1) return "минуту назад";
    if (mins >= 2 && mins <= 4) return mins + " минуты назад";
    return mins + " минут назад";
  }
  return formatWhenRu(d);
}

function setHubStatus(ok, when) {
  const wrap = hubStatus;
  const chip = hubStatusChip;
  const whenEl = hubStatusWhen;
  if (!wrap || !chip) return;
  wrap.classList.remove("hub-status-ok", "hub-status-bad", "hub-status-unknown");
  if (ok === true) {
    wrap.classList.add("hub-status-ok");
    chip.textContent = "Хаб на связи";
    const at = when || state.lastTreeOkAt || new Date();
    state.lastTreeOkAt = at;
    if (whenEl) {
      const label = freshnessLabelRu(at);
      whenEl.textContent = label ? ("Обновлено " + label) : "";
    }
  } else if (ok === false) {
    wrap.classList.add("hub-status-bad");
    chip.textContent = "Нет связи с хабом";
    if (whenEl) {
      const label = state.lastTreeOkAt ? freshnessLabelRu(state.lastTreeOkAt) : "";
      whenEl.textContent = label ? ("Последний раз " + label) : "Дерево дел сейчас недоступно";
    }
  } else {
    wrap.classList.add("hub-status-unknown");
    chip.textContent = "Проверяю связь…";
    if (whenEl) whenEl.textContent = "";
  }
}

function setBanner(health) {
  const el = $("statusBanner");
  if (!el) return;
  const ch = (health && health.channels) || {};
  const bridge = ch.write_bridge || ch.intents || (health && health.write_bridge);
  const fb = (health && health.fallback) || {};
  const level = (fb.level || (bridge && bridge.ok === false ? "warn" : "ok"));
  let text = (health && health.banner_ru) || (fb.banner_ru) || "";
  if (!text) {
    const parts = [];
    if (fb.desktopAlive === false) parts.push("Claude Desktop сейчас недоступен");
    else if (fb.desktopAlive === true) parts.push("Claude Desktop доступен");
    if (bridge && bridge.ok !== false) parts.push("сохранять сообщения в проекты можно");
    text = parts.join(". ") || "Состояние каналов обновлено";
  }
  el.textContent = text;
  el.className = "banner " + (level === "bad" ? "bad" : level === "warn" ? "warn" : "ok");
  el.classList.remove("banner-hidden");
}

function setCrumbs(parts) {
  const el = $("crumbs");
  if (!el) return;
  el.textContent = parts.filter(Boolean).join(" · ");
}

function showPane(name) {
  for (const id of ["pane-welcome", "pane-project", "pane-chat", "pane-material", "pane-service"]) {
    const el = $(id);
    if (!el) continue;
    const on = id === "pane-" + name;
    el.hidden = !on;
    el.classList.toggle("active", on);
  }
  try { syncH16Sticky(name); } catch (e) { /* ignore */ }
}

/* Hour-16 H-lite: sticky primary actions on narrow */
function syncH16Sticky(paneName) {
  const bar = $("h16StickyBar");
  if (!bar) return;
  const narrow = isNarrow();
  const pane = paneName || (["welcome", "project", "chat", "material", "service"].find((n) => {
    const el = $("pane-" + n);
    return el && !el.hidden;
  }) || "welcome");
  if (!narrow) {
    bar.hidden = true;
    document.body.classList.remove("has-h16-sticky");
    return;
  }
  bar.hidden = false;
  document.body.classList.add("has-h16-sticky");
  const btnChat = $("h16StickyNewChat");
  const btnComment = $("h16StickyComment");
  if (btnChat) btnChat.hidden = !(pane === "project" || pane === "chat");
  if (btnComment) btnComment.hidden = pane !== "chat";
}

function persistUi() {
  try {
    localStorage.setItem("most-dash-tree", JSON.stringify({
      expanded: [...state.expanded],
      selected: state.selected,
    }));
  } catch { /* ignore */ }
}

function restoreUi() {
  try {
    const raw = localStorage.getItem("most-dash-tree");
    if (!raw) return;
    const o = JSON.parse(raw);
    if (Array.isArray(o.expanded)) state.expanded = new Set(o.expanded);
    if (o.selected) state.selected = o.selected;
  } catch { /* ignore */ }
}

function iconFor(kind) {
  if (kind === "folder") return "🗂";
  if (kind === "project") return "📁";
  if (kind === "chat") return "💬";
  if (kind === "reply") return "↩";
  if (kind === "chats-folder") return "💬";
  if (kind === "materials-folder") return "📂";
  if (kind === "consilium-folder") return "⚖";
  if (kind === "consilium-round") return "🗂";
  if (kind === "material") return "📄";
  return "•";
}


function isNarrow() {
  return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(max-width: 800px)").matches;
}

function syncTreeToggleUi() {
  const btn = $("treeToggle");
  const backdrop = $("treeBackdrop");
  const open = document.body.classList.contains("tree-open");
  if (btn) {
    btn.textContent = open ? "Закрыть каталог" : "Каталог";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  if (backdrop) {
    if (open && isNarrow()) {
      backdrop.hidden = false;
      backdrop.setAttribute("aria-hidden", "false");
    } else {
      backdrop.hidden = true;
      backdrop.setAttribute("aria-hidden", "true");
    }
  }
}

function openTreeDrawer() {
  document.body.classList.add("tree-open");
  document.body.classList.remove("tree-closed");
  syncTreeToggleUi();
  try { syncH16Sticky(); } catch (e) { /* Hour-23 H-walk */ }
}

function closeTreeDrawer() {
  document.body.classList.remove("tree-open");
  document.body.classList.add("tree-closed");
  syncTreeToggleUi();
  try { syncH16Sticky(); } catch (e) { /* Hour-23 H-walk */ }
}

function maybeCloseDrawerAfterLeaf(kind) {
  if (!isNarrow()) return;
  if (kind === "project" || kind === "chat" || kind === "material" || kind === "consilium-round") {
    closeTreeDrawer();
  }
}

function renderTree() {
  const root = $("explorerTree");
  if (!root || !state.tree) return;
  const nodes = state.tree.nodes || [];
  root.innerHTML = nodes.map((n) => renderNodeHtml(n, 0)).join("") ||
    "<p class=\"muted\">Пока нет дел для дерева.</p>";
  $("treeRootLabel").textContent = state.tree.root_label || "Мои дела";
  $("treeMeta").textContent = "Дел: " + (state.tree.total || nodes.length);

  root.querySelectorAll("[data-twist]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const key = btn.getAttribute("data-twist");
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      persistUi();
      renderTree();
    };
  });
  root.querySelectorAll("[data-select]").forEach((row) => {
    row.onclick = () => {
      const kind = row.getAttribute("data-kind");
      const projectId = row.getAttribute("data-project");
      const chatId = row.getAttribute("data-chat") || null;
      const matTitle = row.getAttribute("data-mat-title") || null;
      const matExcerpt = row.getAttribute("data-mat-excerpt") || null;
      const folderId = row.getAttribute("data-folder") || null;
      const roundId = row.getAttribute("data-round-id") || null;
      const roundNodeId = row.getAttribute("data-round-node") || null;
      const judgeExcerpt = row.getAttribute("data-judge-excerpt") || null;
      const smokeCount = row.getAttribute("data-smoke-count");
      onSelect({
        kind,
        projectId,
        chatId,
        matTitle,
        matExcerpt,
        folderId,
        roundId,
        roundNodeId,
        judgeExcerpt,
        smokeCount: smokeCount === null || smokeCount === "" ? null : smokeCount,
      });
    };
  });
}

function renderNodeHtml(node, depth) {
  const key = node.kind + ":" + node.id;
  const kids = node.children || [];
  const hasKids = kids.length > 0;
  const open = state.expanded.has(key);
  const sel = state.selected &&
    state.selected.kind === node.kind &&
    state.selected.projectId === (node.kind === "project" ? node.id : state.selected.projectId) &&
    (node.kind !== "chat" || state.selected.chatId === node.id) &&
    (node.kind === "project" ? state.selected.kind === "project" && state.selected.projectId === node.id :
      node.kind === "chat" ? state.selected.kind === "chat" && state.selected.chatId === node.id :
      node.kind === "materials-folder" ? state.selected.kind === "materials-folder" && state.selected.projectId === (node.id.split(":")[0]) :
      false);

  // selection match refined
  let selected = false;
  if (state.selected) {
    if (node.kind === "project" && state.selected.kind === "project" && state.selected.projectId === node.id) selected = true;
    if (node.kind === "chat" && state.selected.kind === "chat" && state.selected.chatId === node.id) selected = true;
    if (node.kind === "reply" && state.selected.kind === "chat" && state.selected.chatId === node.parent_chat) selected = true;
    if (node.kind === "material" && state.selected.kind === "material" && state.selected.matTitle === node.title) selected = true;
    if (node.kind === "materials-folder" && state.selected.kind === "materials-folder" && state.selected.projectId + ":materials" === node.id) selected = true;
    if (node.kind === "chats-folder" && state.selected.kind === "chats-folder" && state.selected.projectId + ":chats" === node.id) selected = true;
    if (node.kind === "folder" && state.selected.kind === "folder" && state.selected.folderId === node.id) selected = true;
    if (node.kind === "consilium-folder" && state.selected.kind === "consilium-folder" && state.selected.projectId + ":consilium" === node.id) selected = true;
    if (node.kind === "consilium-round" && state.selected.kind === "consilium-round" && state.selected.roundNodeId === node.id) selected = true;
  }

  const projectId = node.kind === "project" ? node.id
    : (node.kind === "materials-folder" || node.kind === "chats-folder" || node.kind === "consilium-folder" ? node.id.split(":")[0]
      : (node.kind === "consilium-round" ? (node._projectId || (node.id || "").split(":")[0])
      : (node.kind === "folder" ? (node._projectId || null) : null)));
  // For chats we need parent project — stored when rendering under project
  const pidAttr = node._projectId || projectId || "";
  const chatAttr = node.kind === "chat" ? node.id : (node.kind === "reply" ? (node.parent_chat || "") : "");

  const twist = hasKids
    ? "<button type=\"button\" class=\"tree-twist\" data-twist=\"" + escapeHtml(key) + "\" aria-label=\"" +
      (open ? "Свернуть" : "Раскрыть") + "\">" + (open ? "▼" : "▶") + "</button>"
    : "<span class=\"tree-twist leaf\"></span>";

  const status = node.status_ru ? "<span class=\"tree-status\">" + escapeHtml(node.status_ru) + "</span>" : "";

  let attrs = "data-select=\"1\" data-kind=\"" + escapeHtml(node.kind) + "\"";
  if (node.kind === "folder") attrs += " data-folder=\"" + escapeHtml(node.id) + "\"";
  else if (node.kind === "project") attrs += " data-project=\"" + escapeHtml(node.id) + "\"";
  else if (node.kind === "chat") attrs += " data-project=\"" + escapeHtml(pidAttr) + "\" data-chat=\"" + escapeHtml(node.id) + "\"";
  else if (node.kind === "reply") attrs += " data-project=\"" + escapeHtml(pidAttr) + "\" data-chat=\"" + escapeHtml(node.parent_chat || "") + "\" data-kind=\"chat\"";
  else if (node.kind === "chats-folder") attrs += " data-project=\"" + escapeHtml(pidAttr) + "\"";
  else if (node.kind === "materials-folder") attrs += " data-project=\"" + escapeHtml(pidAttr) + "\"";
  else if (node.kind === "consilium-folder") attrs += " data-project=\"" + escapeHtml(pidAttr) + "\"";
  else if (node.kind === "consilium-round") {
    attrs += " data-project=\"" + escapeHtml(pidAttr) + "\"" +
      " data-round-id=\"" + escapeHtml(node.round_id || "") + "\"" +
      " data-round-node=\"" + escapeHtml(node.id || "") + "\"" +
      " data-mat-title=\"" + escapeHtml(node.title || "") + "\"" +
      " data-mat-excerpt=\"" + escapeHtml(node.excerpt || node.first_line || "") + "\"" +
      " data-judge-excerpt=\"" + escapeHtml(node.judge_excerpt || "") + "\"" +
      " data-smoke-count=\"" + escapeHtml(String(node.smoke_count != null ? node.smoke_count : "")) + "\"";
  }
  else if (node.kind === "material") {
    attrs += " data-project=\"" + escapeHtml(pidAttr) + "\" data-mat-title=\"" + escapeHtml(node.title || "") + "\" data-mat-excerpt=\"" + escapeHtml(node.excerpt || "") + "\"";
  }

  let html = "<div class=\"tree-node\" role=\"treeitem\" aria-expanded=\"" + (hasKids ? String(open) : "false") + "\">" +
    "<div class=\"tree-row" + (selected ? " selected" : "") + "\" " + attrs + ">" +
    twist +
    "<span class=\"tree-icon\">" + iconFor(node.kind) + "</span>" +
    "<span class=\"tree-label\" title=\"" + escapeHtml(node.title || "") + "\">" + escapeHtml(node.title || "—") + "</span>" +
    status +
    "</div>";

  if (hasKids) {
    const childHtml = kids.map((c) => {
      const copy = Object.assign({}, c, { _projectId: node.kind === "project" ? node.id : (node._projectId || pidAttr) });
      if (c.kind === "materials-folder" || c.kind === "chats-folder" || c.kind === "consilium-folder" || c.kind === "consilium-round" || c.kind === "material" || c.kind === "reply" || c.kind === "chat" || c.kind === "folder") {
        copy._projectId = node.kind === "project" ? node.id : (node._projectId || pidAttr);
        if (c.children) {
          copy.children = c.children.map((gc) => Object.assign({}, gc, { _projectId: copy._projectId }));
        }
      }
      return renderNodeHtml(copy, depth + 1);
    }).join("");
    html += "<div class=\"tree-children" + (open ? "" : " collapsed") + "\" role=\"group\">" + childHtml + "</div>";
  }
  html += "</div>";
  return html;
}

async function onSelect(sel) {
  if (sel.kind === "reply") sel.kind = "chat";
  state.selected = sel;
  persistUi();
  renderTree();
  maybeCloseDrawerAfterLeaf(sel.kind);

  if (sel.kind === "folder") {
    const fid = sel.folderId || "";
    const key = "folder:" + fid;
    if (fid) state.expanded.add(key);
    if (/:smoke$/.test(fid)) {
      const pid = fid.split(":")[0];
      state.expanded.add("project:" + pid);
      persistUi();
      renderTree();
      await loadProjectPane(pid);
      setCrumbs([pid, "Проверки моста"]);
      return;
    }
    persistUi();
    renderTree();
    showPane("welcome");
    setCrumbs([fid === "rubric:done" ? "Завершённые" : fid === "rubric:active" ? "В работе" : "Папка"]);
    const tip = $("pane-welcome");
    if (tip) {
      const h = tip.querySelector("h2");
      const p = tip.querySelector("p.lead");
      if (h) h.textContent = fid === "rubric:done" ? "Завершённые дела" : fid === "rubric:active" ? "Дела в работе" : "Папка";
      if (p) p.textContent = "Раскройте папку слева стрелкой и выберите дело — справа появится содержание.";
    }
    return;
  }
  if (sel.kind === "service") {
    showPane("service");
    setCrumbs(["Служебное"]);
    await loadService();
    return;
  }
  if (sel.kind === "material") {
    showPane("material");
    $("materialTitle").textContent = sel.matTitle || "Материал";
    const bodyPre = $("materialBody");
    const summary = $("materialSummary");
    if (summary) summary.hidden = true;
    if (bodyPre) {
      bodyPre.hidden = false;
      bodyPre.textContent = sel.matExcerpt || "Нет краткого текста.";
    }
    setCrumbs([sel.projectId, "Материалы", sel.matTitle]);
    return;
  }
  if (sel.kind === "chats-folder") {
    const key = "chats-folder:" + sel.projectId + ":chats";
    state.expanded.add(key);
    state.expanded.add("project:" + sel.projectId);
    persistUi();
    renderTree();
    await loadProjectPane(sel.projectId);
    setCrumbs([sel.projectId, "Разговоры"]);
    const hint = $("projectHint");
    if (hint) hint.textContent = "Раскройте «Разговоры» слева и выберите беседу — справа откроется переписка.";
    return;
  }
  if (sel.kind === "materials-folder") {
    const key = "materials-folder:" + sel.projectId + ":materials";
    state.expanded.add(key);
    state.expanded.add("project:" + sel.projectId);
    persistUi();
    await loadProjectPane(sel.projectId);
    return;
  }
  if (sel.kind === "consilium-folder") {
    const key = "consilium-folder:" + sel.projectId + ":consilium";
    state.expanded.add(key);
    state.expanded.add("project:" + sel.projectId);
    persistUi();
    renderTree();
    await loadProjectPane(sel.projectId);
    setCrumbs([sel.projectId, "Консилиум"]);
    const hint = $("projectHint");
    if (hint) hint.textContent = "Раскройте «Консилиум» слева и выберите шаг — справа откроется сводка задачи и проверок.";
    return;
  }
  if (sel.kind === "consilium-round") {
    state.expanded.add("project:" + sel.projectId);
    state.expanded.add("consilium-folder:" + sel.projectId + ":consilium");
    persistUi();
    renderTree();
    showPane("material");
    const titleEl = $("materialTitle");
    const bodyPre = $("materialBody");
    const summary = $("materialSummary");
    if (titleEl) titleEl.textContent = sel.matTitle || "Шаг консилиума";
    if (bodyPre) bodyPre.hidden = true;
    if (summary) {
      summary.hidden = false;
      const taskText = sel.matExcerpt || "Краткого текста задачи пока нет.";
      const smokeN = sel.smokeCount != null && sel.smokeCount !== "" ? Number(sel.smokeCount) : null;
      let checksHtml = "<p>Проверки моста для этого дела лежат в папке «Проверки моста» слева.</p>";
      if (smokeN != null && !Number.isNaN(smokeN)) {
        checksHtml = "<p>Связанных проверок моста в деле: <strong>" + escapeHtml(String(smokeN)) + "</strong>. " +
          "Откройте папку «Проверки моста» слева, чтобы увидеть каждую.</p>";
      }
      let judgeBlock = "";
      if (sel.judgeExcerpt) {
        judgeBlock = "<details class=\"round-summary\"><summary>Итог</summary>" +
          "<pre class=\"round-excerpt\">" + escapeHtml(sel.judgeExcerpt) + "</pre></details>";
      }
      summary.innerHTML =
        "<details class=\"round-summary\" open><summary>Задача</summary>" +
        "<pre class=\"round-excerpt\">" + escapeHtml(taskText) + "</pre></details>" +
        "<details class=\"round-summary\"><summary>Проверки</summary>" +
        "<div class=\"round-checks\">" + checksHtml + "</div></details>" +
        judgeBlock;
    } else if (bodyPre) {
      bodyPre.hidden = false;
      bodyPre.textContent = (sel.matExcerpt || "Нет краткого текста.") +
        "\n\n— Проверки моста: см. папку «Проверки моста».";
    }
    setCrumbs([sel.projectId, "Консилиум", sel.matTitle || sel.roundId || "Шаг"]);
    return;
  }
  if (sel.kind === "project") {
    state.expanded.add("project:" + sel.projectId);
    persistUi();
    renderTree();
    await loadProjectPane(sel.projectId);
    return;
  }
  if (sel.kind === "chat") {
    state.expanded.add("project:" + sel.projectId);
    state.expanded.add("chats-folder:" + sel.projectId + ":chats");
    state.expanded.add("folder:" + sel.projectId + ":smoke");
    persistUi();
    renderTree();
    await loadChatPane(sel.projectId, sel.chatId);
    return;
  }
  showPane("welcome");
  setCrumbs([]);
}

function findNodeById(nodes, id) {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

async function loadTree() {
  try {
    const data = await api("GET", "/api/tree");
    state.tree = data;
    // Auto-expand «В работе» and collegium-hub if nothing restored
    if (state.expanded.size === 0) {
      const active = (data.nodes || []).find((n) => n.id === "rubric:active");
      if (active) state.expanded.add("folder:rubric:active");
      if (findNodeById(data.nodes || [], "collegium-hub")) {
        state.expanded.add("project:collegium-hub");
      }
    }
    renderTree();
    setHubStatus(true, new Date());
  } catch (e) {
    setHubStatus(false);
    throw e;
  }
}

async function loadProjectPane(id) {
  state.projectId = id;
  state.chatId = null;
  const data = await api("GET", "/api/projects/" + encodeURIComponent(id));
  state.project = data;
  showPane("project");
  $("projectTitle").textContent = data.title || "Дело";
  $("projectStatus").textContent = data.status_ru || "";
  $("projectGoal").textContent = data.goal || data.next_step || "Краткого описания пока нет.";
  $("projectOwner").textContent = data.owner_label ? ("Ведёт: " + data.owner_label) : "";
  setCrumbs([data.title || id]);
}

function renderThread(chat) {
  const box = $("thread");
  if (!box) return;
  const msgs = chat.messages || [];
  box.innerHTML = msgs.map((m) => {
    const cls = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system";
    return "<div class=\"bubble " + cls + "\"><div class=\"who\">" +
      escapeHtml(m.role_label || "") + (m.at ? " · " + escapeHtml(fmtTime(m.at)) : "") +
      "</div>" + escapeHtml(m.text || "") + "</div>";
  }).join("") || "<p class=\"muted\">Пока нет сообщений.</p>";
}

function renderChatActions(chat) {
  const wrap = $("chatActionButtons");
  if (!wrap) return;
  const acts = chat.actions || {};
  const bridge = chat._bridge || {};
  const buttons = [];
  if (acts.can_confirm) {
    buttons.push("<button type=\"button\" class=\"btn-primary\" id=\"btnConfirm\">Подтвердить сообщение</button>");
  }
  if (acts.can_enqueue) {
    buttons.push("<button type=\"button\" class=\"btn-primary\" id=\"btnEnqueue\">Передать помощнику</button>");
  }
  wrap.innerHTML = buttons.join(" ");
  const confirmBtn = $("btnConfirm");
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      await api("POST", "/api/intents/" + encodeURIComponent(bridge.work) + "/" + encodeURIComponent(bridge.id) + "/confirm", {});
      await loadChatPane(bridge.work, bridge.id);
      await loadTree();
    };
  }
  const enqBtn = $("btnEnqueue");
  if (enqBtn) {
    enqBtn.onclick = async () => {
      const r = await api("POST", "/api/intents/" + encodeURIComponent(bridge.work) + "/" + encodeURIComponent(bridge.id) + "/enqueue", {});
      if (r && (r.needsToken || r.fallbackConfirmId || (r.intent && r.intent.fallbackConfirmId))) {
        const id = r.fallbackConfirmId || (r.intent && r.intent.fallbackConfirmId) || "";
        $("confirmIdInput").value = id;
        $("keyBox").open = true;
        $("keyMeta").textContent = "Нужен ключ с вашего компьютера.";
        if (r.cli_fallback || (r.intent && r.intent.cli_fallback)) {
          $("revealCmd").textContent = r.cli_fallback || r.intent.cli_fallback;
        }
      } else {
        await loadChatPane(bridge.work, bridge.id);
        await loadTree();
      }
    };
  }
  if (bridge.fallbackConfirmId) $("confirmIdInput").value = bridge.fallbackConfirmId;
  if (bridge.cli_fallback) $("revealCmd").textContent = bridge.cli_fallback;
}

async function loadChatPane(projectId, chatId) {
  state.projectId = projectId;
  state.chatId = chatId;
  const chat = await api("GET", "/api/projects/" + encodeURIComponent(projectId) + "/chats/" + encodeURIComponent(chatId));
  state.chat = chat;
  showPane("chat");
  $("chatTitle").textContent = chat.title || "Разговор";
  $("chatSub").textContent = [chat.project_title, chat.agent_label, chat.status_ru, chat.provenance_label].filter(Boolean).join(" · ");
  $("chatNext").textContent = chat.next_step_ru || "";
  $("chatJudgeNote").textContent = (chat.actions && chat.actions.judge_note) || "";
  renderThread(chat);
  renderChatActions(chat);
  const rel = $("chatRelated");
  if (chat.related && chat.related.length) {
    rel.classList.remove("hidden");
    rel.innerHTML = "<strong>Рядом:</strong><ul>" + chat.related.map((x) =>
      "<li>" + escapeHtml(x.title || "") + (x.preview ? " — " + escapeHtml(x.preview) : "") + "</li>"
    ).join("") + "</ul>";
  } else {
    rel.classList.add("hidden");
    rel.innerHTML = "";
  }
  setCrumbs([chat.project_title || projectId, chat.title || chatId]);
}

async function loadService() {
  showPane("service");
  const ready = await api("GET", "/api/ready");
  const box = $("serviceReady");
  const servers = (ready && ready.servers) || ready || {};
  const names = Object.keys(servers);
  box.innerHTML = names.map((n) => {
    const s = servers[n] || {};
    const label = n === "antigravity" ? "Антигравити" : n === "codex" ? "Кодекс" : n === "grok" ? "Грок" : n === "team" ? "Команда" : n;
    const st = s.alive ? "на связи" : (s.present ? "не отвечает" : "нет данных");
    return "<div class=\"card\"><strong>" + escapeHtml(label) + "</strong><div class=\"muted\">" + escapeHtml(st) + "</div></div>";
  }).join("") || "<p class=\"muted\">Нет данных о каналах.</p>";
  try {
    const q = await api("GET", "/api/quotas");
    $("serviceQuotas").textContent = JSON.stringify(q, null, 2);
  } catch (e) {
    $("serviceQuotas").textContent = "Квоты недоступны: " + e.message;
  }
}


async function createNewProject() {
  const title = window.prompt("Как назвать новое дело?", "");
  if (title == null) return;
  const name = String(title).trim();
  if (name.length < 2) {
    window.alert("Нужно название хотя бы из двух букв.");
    return;
  }
  try {
    const r = await api("POST", "/api/projects", { title: name });
    const id = r && r.project && r.project.id;
    await loadTree();
    if (id) {
      state.expanded.add("folder:rubric:active");
      state.expanded.add("project:" + id);
      persistUi();
      await onSelect({ kind: "project", projectId: id });
    }
  } catch (e) {
    window.alert("Не удалось создать дело: " + (e.message || e));
  }
}

async function createNewChat() {
  if (!state.projectId) {
    window.alert("Сначала выберите дело слева.");
    return;
  }
  let first = window.prompt("О чём разговор? (можно коротко)", "Новый разговор");
  if (first == null) return;
  first = String(first).trim();
  if (first.length < 3) first = "Новый разговор";
  try {
    const who = ($("composeWho") && $("composeWho").value) || "grok";
    const r = await api("POST", "/api/intents", { work: state.projectId, who, task: first });
    const id = r && r.intent && r.intent.id;
    await loadTree();
    state.expanded.add("project:" + state.projectId);
    state.expanded.add("chats-folder:" + state.projectId + ":chats");
    persistUi();
    if (id) {
      await onSelect({ kind: "chat", projectId: state.projectId, chatId: id });
      const ta = $("followupText");
      if (ta) { ta.focus(); }
    }
  } catch (e) {
    window.alert("Не удалось создать разговор: " + (e.message || e));
  }
}

async function composeDraft() {
  const who = $("composeWho").value;
  const task = ($("composeText").value || "").trim();
  const meta = $("composeMeta");
  if (!state.projectId) { meta.textContent = "Сначала выберите дело в дереве."; return; }
  if (!task) { meta.textContent = "Напишите текст сообщения."; return; }
  meta.textContent = "Сохраняю…";
  const r = await api("POST", "/api/intents", { work: state.projectId, who, task });
  meta.textContent = "Черновик сохранён.";
  $("composeText").value = "";
  await loadTree();
  const id = r && r.intent && r.intent.id;
  if (id) {
    state.expanded.add("project:" + state.projectId);
    await onSelect({ kind: "chat", projectId: state.projectId, chatId: id });
  }
}

async function followupDraft() {
  const task = ($("followupText").value || "").trim();
  const meta = $("followupMeta");
  const work = state.projectId;
  const who = (state.chat && state.chat.agent) || "grok";
  if (!work || !task) { meta.textContent = "Нужен текст."; return; }
  meta.textContent = "Сохраняю…";
  const r = await api("POST", "/api/intents", { work, who, task });
  meta.textContent = "Комментарий сохранён.";
  $("followupText").value = "";
  await loadTree();
  if (r && r.intent && r.intent.id) {
    await onSelect({ kind: "chat", projectId: work, chatId: r.intent.id });
  }
}


/* Hour-22 R-lite: calm auto-refresh every 60s — quiet tree/health poll, freshnessLabelRu, no reload/toast spam */
const CALM_REFRESH_MS = 60 * 1000;
let calmRefreshTimer = null;
let calmRefreshing = false;

function tickHubFreshnessOnly() {
  const wrap = typeof hubStatus !== "undefined" ? hubStatus : null;
  if (!wrap || !state.lastTreeOkAt) return;
  const ok = wrap.classList.contains("hub-status-ok");
  const bad = wrap.classList.contains("hub-status-bad");
  if (ok) setHubStatus(true, state.lastTreeOkAt);
  else if (bad) setHubStatus(false);
}

async function calmAutoRefreshTick() {
  if (calmRefreshing) return;
  if (typeof document !== "undefined" && document.hidden) {
    tickHubFreshnessOnly();
    return;
  }
  calmRefreshing = true;
  try {
    await refreshAll();
  } catch (e) {
    /* loadTree/setHubStatus already mark bad; stay quiet */
  } finally {
    calmRefreshing = false;
  }
}

function startCalmAutoRefresh() {
  if (calmRefreshTimer) return;
  calmRefreshTimer = setInterval(calmAutoRefreshTick, CALM_REFRESH_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        tickHubFreshnessOnly();
        calmAutoRefreshTick();
      }
    });
  }
}

async function refreshAll() {
  try {
    const h = await api("GET", "/api/health");
    setBanner(h);
  } catch (e) {
    setBanner({ banner_ru: "Не удалось обновить состояние: " + e.message, fallback: { level: "warn" } });
  }
  $("clock").textContent = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Nicosia" });
  try {
    await loadTree();
  } catch (e) {
    const meta = $("treeMeta");
    if (meta) meta.textContent = "Не удалось обновить дерево дел.";
  }
  if (state.selected && state.selected.kind === "chat" && state.selected.chatId) {
    try { await loadChatPane(state.selected.projectId, state.selected.chatId); } catch { /* keep prior */ }
  } else if (state.selected && state.selected.kind === "project") {
    try { await loadProjectPane(state.selected.projectId); } catch { /* keep prior */ }
  }
}

function wire() {
  $("btnHome").onclick = () => {
    state.selected = null;
    persistUi();
    renderTree();
    showPane("welcome");
    setCrumbs([]);
    if (isNarrow()) openTreeDrawer();
  };
  const treeToggle = $("treeToggle");
  if (treeToggle) {
    treeToggle.onclick = () => {
      if (document.body.classList.contains("tree-open")) closeTreeDrawer();
      else openTreeDrawer();
    };
  }
  const backdrop = $("treeBackdrop");
  if (backdrop) {
    backdrop.onclick = () => closeTreeDrawer();
  }
  window.addEventListener("resize", () => {
    if (!isNarrow()) {
      document.body.classList.remove("tree-open", "tree-closed");
      syncTreeToggleUi();
    } else if (!document.body.classList.contains("tree-open") && !document.body.classList.contains("tree-closed")) {
      openTreeDrawer();
    } else {
      syncTreeToggleUi();
    }
  });
  $("btnRefresh").onclick = () => refreshAll();
  $("btnService").onclick = () => onSelect({ kind: "service" });
  $("btnBackFromService").onclick = () => {
    state.selected = null;
    showPane("welcome");
    setCrumbs([]);
    renderTree();
  };
  $("btnComposeDraft").onclick = () => composeDraft();
  $("btnFollowup").onclick = () => followupDraft();
  const btnNewProject = $("btnNewProject");
  if (btnNewProject) btnNewProject.onclick = () => createNewProject();
  const btnNewChat = $("btnNewChat");
  if (btnNewChat) btnNewChat.onclick = () => createNewChat();
  /* Hour-16 H-lite sticky mirrors */
  const h16New = $("h16StickyNewProject");
  if (h16New) h16New.onclick = () => createNewProject();
  const h16Chat = $("h16StickyNewChat");
  if (h16Chat) h16Chat.onclick = () => createNewChat();
  const h16Comment = $("h16StickyComment");
  if (h16Comment) h16Comment.onclick = () => followupDraft();
  window.addEventListener("resize", () => {
    try { syncH16Sticky(); } catch (e) { /* ignore */ }
  });
  $("btnCopyReveal").onclick = async () => {
    const t = $("revealCmd").textContent || "";
    try { await navigator.clipboard.writeText(t); $("keyMeta").textContent = "Скопировано."; }
    catch { $("keyMeta").textContent = "Не удалось скопировать — выделите вручную."; }
  };
  $("btnHostEnqueue").onclick = async () => {
    const bridge = (state.chat && state.chat._bridge) || {};
    const confirmId = ($("confirmIdInput").value || "").trim();
    const confirmToken = ($("confirmTokenInput").value || "").trim();
    if (!confirmId || !confirmToken) {
      $("keyMeta").textContent = "Нужны и номер, и ключ.";
      return;
    }
    await api("POST", "/api/intents/" + encodeURIComponent(bridge.work) + "/" + encodeURIComponent(bridge.id) + "/enqueue", {
      confirmId, confirmToken,
    });
    $("confirmTokenInput").value = "";
    $("keyMeta").textContent = "Передано.";
    await loadChatPane(bridge.work, bridge.id);
    await loadTree();
  };
}

async function boot() {
  restoreUi();
  wire();
  /* hour11 boot drawer */
  if (isNarrow()) openTreeDrawer();
  else {
    document.body.classList.remove("tree-open", "tree-closed");
    syncTreeToggleUi();
  }
  showPane("welcome");
  try { syncH16Sticky("welcome"); } catch (e) { /* ignore */ }
  await refreshAll();
  startCalmAutoRefresh();
  if (state.selected) {
    try { await onSelect(state.selected); } catch { /* stay welcome */ }
  }
}

boot().catch((e) => {
  setBanner({ banner_ru: "Ошибка запуска экрана: " + e.message, fallback: { level: "bad" } });
});
