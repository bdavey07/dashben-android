// extras.mjs — shared by the web client (PKM-new/public/local) and the
// Android shell (dashben-android/www). Keep the two copies IDENTICAL:
// everything client-specific comes in through the ctx object that
// app.mjs passes to installExtras(), so this file never needs a
// per-client variant.
//
// What lives here (stamp eu):
//  - quick-add extras: +project, #tags, "in 3 days", "next fri",
//    "!high" / "!1", and a time ("3pm", "at 15:30") that becomes a
//    reminder on the task
//  - [[wiki links]]: rendering, click-to-open, autocomplete while
//    typing, and "Mentioned in" backlinks
//  - per-task reminder times (ui_prefs "task_reminders", synced):
//    browser notifications on the web, native ones in the shell
//  - Daily timeline: calendar events, schedule lines and reminders
//    for the viewed day, in time order
//  - sync pill + page title in the header, accent colour, system bar
//    colours (shell), back-button handling (shell)

let ctx = null;

export function installExtras(c) {
  ctx = c;
  document.addEventListener("click", onDocClick);
  document.addEventListener("input", onDocInput);
  document.addEventListener("keydown", onDocKeydown, true);
  document.addEventListener("change", onDocChange);
  document.addEventListener("focusout", () => setTimeout(() => {
    const a = document.activeElement;
    if (a !== wikiAc.ta && !wikiAc.root?.contains(a)) closeWikiAc();
  }, 150));
  installDaySwipe();
  window.__dashbenBack = handleBack;
  applyAccent();
  scheduleWebReminders();
}

// Called at the end of every render() in app.mjs.
export function afterRender() {
  if (!ctx) return;
  updateSyncPill();
  updatePageTitle();
  applyAccent();
  syncSystemBars();
  scheduleWebReminders();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------
// Quick-add extras
// ---------------------------------------------------------------
// Runs BEFORE the existing date/priority parser. Tokens it owns are
// removed from the text; relative dates are rewritten to YYYY-MM-DD
// so the existing parser picks them up unchanged.
const WEEKDAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function ymdAddDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function preParseQuick(raw, today) {
  let text = ` ${String(raw ?? "")} `;
  const out = { project: null, tags: [], time: null, priority: null };
  // Project: +"Multi word" or +Word (matched to an existing project).
  const pq = /\s\+"([^"]{1,80})"/.exec(text) || /\s\+([\p{L}\p{N}_-]{1,60})/u.exec(text);
  if (pq) {
    out.project = resolveProject(pq[1].replace(/_/g, " "));
    text = text.replace(pq[0], " ");
  }
  // Tags: #word (not inside a URL fragment).
  text = text.replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})(?=\s)/gu, (m, pre, tag) => { out.tags.push(tag.toLowerCase()); return pre; });
  // Priority: !1 / !2 / !3, !high / !med / !low, !!! / !!
  const bang = /\s!(1|2|3|high|hi|med|medium|low|!{1,2})(?=\s)/i.exec(text);
  if (bang) {
    const v = bang[1].toLowerCase();
    out.priority = { "1": "P1", high: "P1", hi: "P1", "!!": "P1", "2": "P2", med: "P2", medium: "P2", "!": "P2", "3": "P3", low: "P3" }[v] ?? null;
    text = text.replace(bang[0], " ");
  }
  // Time: "at 3pm", "3:30 pm", "15:00" (24h needs the colon).
  const t12 = /\s(?:at\s+)?(\d{1,2})(?::([0-5]\d))?\s*(am|pm)(?=\s)/i.exec(text);
  const t24 = t12 ? null : /\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/.exec(text);
  if (t12) {
    let h = Number(t12[1]) % 12;
    if (t12[3].toLowerCase() === "pm") h += 12;
    if (Number(t12[1]) <= 12) out.time = `${String(h).padStart(2, "0")}:${t12[2] ?? "00"}`;
    text = text.replace(t12[0], " ");
  } else if (t24) {
    out.time = `${t24[1].padStart(2, "0")}:${t24[2]}`;
    text = text.replace(t24[0], " ");
  }
  // Relative dates the base parser does not know.
  text = text.replace(/\sin\s+(\d{1,3})\s+(day|days|week|weeks|month|months)(?=\s)/i, (m, n, unit) => {
    const k = Number(n);
    const u = unit.toLowerCase();
    if (u.startsWith("day")) return ` ${ymdAddDays(today, k)} `;
    if (u.startsWith("week")) return ` ${ymdAddDays(today, 7 * k)} `;
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + k);
    return ` ${d.toISOString().slice(0, 10)} `;
  });
  text = text.replace(/\snext\s+(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?=\s)/i, (m, wd) => {
    const now = new Date(`${today}T12:00:00Z`).getUTCDay();
    const want = WEEKDAYS[wd.toLowerCase()];
    // "next friday" = the Friday of NEXT week (Monday-start weeks),
    // the way most people mean it; plain "friday" (handled by the
    // base parser) is the coming one.
    let delta = (want - now + 7) % 7 || 7;
    const mi = (d) => (d + 6) % 7;
    if (mi(want) > mi(now)) delta += 7;
    return ` ${ymdAddDays(today, delta)} `;
  });
  out.text = text.replace(/\s+/g, " ").trim();
  return out;
}

function resolveProject(name) {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  let rows = [];
  try { rows = ctx.state.db.prepare("SELECT title FROM projects WHERE archived=0").all(); } catch { rows = []; }
  const exact = rows.find((r) => (r.title ?? "").toLowerCase() === want);
  if (exact) return exact.title;
  const pre = rows.filter((r) => (r.title ?? "").toLowerCase().startsWith(want));
  if (pre.length === 1) return pre[0].title;
  return name.trim();
}

// After the task exists: tags and reminder time.
export function applyQuickAfterCreate(taskId, extras, due) {
  if (!taskId || !extras) return;
  try {
    if (extras.tags?.length) {
      const cur = ctx.state.store.listTags("tasks", taskId) ?? [];
      ctx.state.store.setTags("tasks", taskId, [...new Set([...cur, ...extras.tags])]);
    }
  } catch { /* tags are best-effort */ }
  if (extras.time) {
    const day = due || ctx.todayToronto();
    setReminder(taskId, `${day}T${extras.time}`);
  }
}

// ---------------------------------------------------------------
// [[Wiki links]]
// ---------------------------------------------------------------
const WIKI_TABLES = [["notes", "Note"], ["people", "Person"], ["projects", "Project"], ["tasks", "Task"], ["reading_items", "Reading"]];

// Post-processes renderMarkdown() output. Input is already escaped
// HTML, so the captured title is escaped text and safe to reuse in an
// attribute. <pre>/<code> spans are left alone.
export function wikilinkify(html) {
  return String(html).split(/(<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/).map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/\[\[([^[\]\n|]{1,120})(?:\|([^[\]\n]{1,120}))?\]\]/g, (m, target, label) => {
      const t = target.trim();
      const found = findByTitle(unescapeHtml(t));
      const cls = found ? "wikilink" : "wikilink wikilink-new";
      return `<a href="#" class="${cls}" data-wikilink="${t}" title="${found ? "Open" : "Create"} “${t}”">${(label ?? t).trim()}</a>`;
    });
  }).join("");
}

function unescapeHtml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e]));
}

function findByTitle(title) {
  const want = String(title).trim().toLowerCase();
  if (!want || !ctx?.state?.db) return null;
  for (const [table] of WIKI_TABLES) {
    try {
      const r = ctx.state.db.prepare(`SELECT id FROM ${table} WHERE archived=0 AND lower(title)=? ORDER BY updated_at DESC LIMIT 1`).get(want);
      if (r) return { type: table, id: r.id };
    } catch { /* table shape */ }
  }
  return null;
}

function openWikilink(el) {
  const title = unescapeHtml(el.dataset.wikilink ?? "");
  let hit = findByTitle(title);
  const go = () => {
    if (!hit) {
      if (!confirm(`No item called “${title}” yet. Create a note with that title?`)) return;
      const row = ctx.state.store.createNote({ title });
      hit = { type: "notes", id: row?.id ?? row };
      ctx.saveBytes();
    }
    ctx.openPopupByRef(hit.type, hit.id);
  };
  // Leaving an open editor: save it first, exactly like a backdrop
  // click, so following a link never discards an edit.
  if (el.closest("#popup-root") && ctx.savePopupAndClose) { ctx.savePopupAndClose(); setTimeout(go, 60); }
  else go();
}

// "Mentioned in": items whose body contains [[This title]].
export function wikiMentions(type, id) {
  const row = ctx?.state?.store?.getRow(type, id);
  const title = row?.title?.trim();
  if (!title) return [];
  const out = [];
  const needle = `%[[${title.toLowerCase()}%`;
  for (const [table] of WIKI_TABLES) {
    try {
      for (const r of ctx.state.db.prepare(`SELECT id, title, body_markdown FROM ${table} WHERE archived=0 AND lower(body_markdown) LIKE ? LIMIT 30`).all(needle)) {
        if (table === type && r.id === id) continue;
        const re = new RegExp(`\\[\\[\\s*${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\]\\]|\\|)`, "i");
        if (re.test(r.body_markdown ?? "")) out.push({ type: table, id: r.id, row: r });
      }
    } catch { /* table shape */ }
  }
  return out;
}

export function mentionsHtml(type, id) {
  const list = wikiMentions(type, id);
  if (!list.length) return "";
  const label = Object.fromEntries(WIKI_TABLES);
  return `<h4>Mentioned in</h4>${list.map((m) => `<div class="row"><span class="badge">${esc(label[m.type] ?? m.type)}</span><span class="row-title" data-open="${m.type}:${m.id}">${esc(m.row.title)}</span></div>`).join("")}`;
}

// Autocomplete: typing [[ in any Markdown textarea offers titles.
const wikiAc = { root: null, ta: null, items: [], idx: 0, start: -1 };

function wikiQueryAt(ta) {
  const pos = ta.selectionStart;
  const before = ta.value.slice(Math.max(0, pos - 80), pos);
  const m = /\[\[([^[\]\n]*)$/.exec(before);
  if (!m) return null;
  return { q: m[1], start: pos - m[1].length };
}

function wikiCandidates(q) {
  const lq = q.trim().toLowerCase();
  const out = [];
  for (const [table, label] of WIKI_TABLES) {
    try {
      const rows = lq
        ? ctx.state.db.prepare(`SELECT id, title FROM ${table} WHERE archived=0 AND lower(title) LIKE ? ORDER BY (lower(title) LIKE ?) DESC, updated_at DESC LIMIT 6`).all(`%${lq}%`, `${lq}%`)
        : ctx.state.db.prepare(`SELECT id, title FROM ${table} WHERE archived=0 ORDER BY updated_at DESC LIMIT 3`).all();
      for (const r of rows) if (r.title) out.push({ type: table, label, title: r.title });
    } catch { /* table shape */ }
  }
  return out.slice(0, 8);
}

function showWikiAc(ta, info) {
  const items = wikiCandidates(info.q);
  if (!items.length && !info.q.trim()) { closeWikiAc(); return; }
  if (!wikiAc.root) {
    wikiAc.root = document.createElement("div");
    wikiAc.root.className = "wiki-ac";
    wikiAc.root.setAttribute("role", "listbox");
    wikiAc.root.addEventListener("mousedown", (e) => {
      const b = e.target.closest("[data-wiki-pick]");
      if (!b) return;
      e.preventDefault();
      pickWiki(Number(b.dataset.wikiPick));
    });
    document.body.appendChild(wikiAc.root);
  }
  wikiAc.ta = ta;
  wikiAc.items = items;
  wikiAc.start = info.start;
  wikiAc.idx = 0;
  const createRow = info.q.trim() && !items.some((i) => i.title.toLowerCase() === info.q.trim().toLowerCase());
  if (createRow) wikiAc.items = [...items, { type: null, label: "New", title: info.q.trim() }];
  paintWikiAc();
  const r = ta.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - 260);
  wikiAc.root.style.left = `${Math.max(8, r.left)}px`;
  wikiAc.root.style.top = `${Math.max(8, top)}px`;
  wikiAc.root.style.width = `${Math.min(360, r.width)}px`;
  wikiAc.root.hidden = false;
}

function paintWikiAc() {
  wikiAc.root.innerHTML = wikiAc.items.map((it, i) => `<button type="button" role="option" data-wiki-pick="${i}" class="${i === wikiAc.idx ? "active" : ""}"><span class="wiki-ac-type">${esc(it.label)}</span>${esc(it.title)}</button>`).join("");
}

function closeWikiAc() {
  if (wikiAc.root) wikiAc.root.hidden = true;
  wikiAc.ta = null;
}

function pickWiki(i) {
  const it = wikiAc.items[i];
  const ta = wikiAc.ta;
  if (!it || !ta) return closeWikiAc();
  const pos = ta.selectionStart;
  const after = ta.value.slice(pos);
  const closing = after.startsWith("]]") ? "" : "]]";
  ta.value = ta.value.slice(0, wikiAc.start) + it.title + closing + after;
  const caret = wikiAc.start + it.title.length + 2;
  ta.setSelectionRange(caret, caret);
  closeWikiAc();
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.focus();
}

// ---------------------------------------------------------------
// Per-task reminders (ui_prefs "task_reminders": {taskId: "YYYY-MM-DDTHH:MM"})
// ---------------------------------------------------------------
const REM_KEY = "task_reminders";

export function getReminders() {
  try { const v = JSON.parse(ctx.state.store.getPref(REM_KEY) ?? "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

export function setReminder(taskId, when) {
  const m = getReminders();
  if (when) m[taskId] = when; else delete m[taskId];
  // Drop entries for tasks that are gone, done or archived.
  for (const id of Object.keys(m)) {
    const t = ctx.state.store.getRow("tasks", id);
    if (!t || t.archived || t.done) delete m[id];
  }
  ctx.state.store.setPref(REM_KEY, JSON.stringify(m));
  ctx.saveBytes();
  requestNotifyPermission();
  ctx.onRemindersChanged?.();
  scheduleWebReminders(true);
}

// Upcoming timed reminders for open tasks: [{ taskId, title, at: Date }].
export function timedReminders() {
  const m = getReminders();
  const now = Date.now();
  const out = [];
  for (const [id, when] of Object.entries(m)) {
    const t = ctx.state.store.getRow("tasks", id);
    if (!t || t.archived || t.done) continue;
    const at = new Date(when);
    if (Number.isNaN(at.getTime()) || at.getTime() <= now) continue;
    out.push({ taskId: id, title: t.title, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function reminderFieldHtml(task) {
  if (!task?.id) return "";
  const cur = getReminders()[task.id] ?? "";
  const past = cur && new Date(cur).getTime() <= Date.now();
  return `<h4>Reminder</h4><div class="reminder-row"><input type="datetime-local" data-reminder="${esc(task.id)}" value="${esc(cur)}" aria-label="Reminder time">${cur ? `<button type="button" class="ghost-btn" data-reminder-clear="${esc(task.id)}">Clear</button>` : ""}${past ? `<span class="muted">already passed</span>` : ""}</div>`;
}

function requestNotifyPermission() {
  if (ctx.isShell) return; // the shell asks through its own plugin
  try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch { /* unsupported */ }
}

// Web only: in-page timers for reminders in the next 24 h. The shell
// schedules real OS notifications instead (see app.mjs).
const webTimers = new Map();
let webSig = "";
function scheduleWebReminders(force = false) {
  if (!ctx || ctx.isShell || !ctx.state.store) return;
  const list = timedReminders().filter((r) => r.at.getTime() - Date.now() < 86400000);
  const sig = list.map((r) => `${r.taskId}@${r.at.getTime()}`).join(",");
  if (!force && sig === webSig) return;
  webSig = sig;
  for (const t of webTimers.values()) clearTimeout(t);
  webTimers.clear();
  for (const r of list) {
    webTimers.set(r.taskId, setTimeout(() => fireWebReminder(r), Math.max(0, r.at.getTime() - Date.now())));
  }
}

function fireWebReminder(r) {
  const t = ctx.state.store.getRow("tasks", r.taskId);
  if (!t || t.done || t.archived) return;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification("DashBen reminder", { body: t.title, tag: `rem-${r.taskId}` });
      n.onclick = () => { window.focus(); ctx.openPopupByRef("tasks", r.taskId); n.close(); };
      return;
    }
  } catch { /* fall through to the in-app toast */ }
  ctx.toast?.(`Reminder: ${t.title}`);
}

// ---------------------------------------------------------------
// Daily timeline
// ---------------------------------------------------------------
// items: calendar events of the day, "9:00 — Thing" schedule lines
// from the daily note, and timed reminders of tasks due that day.
export function timelineHtml(date, { events = [], scheduleLines = [], eventsStatus = "ok" } = {}) {
  const rows = [];
  const allDay = [];
  const torontoHM = (iso) => {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso)); } catch { return String(iso).slice(11, 16); }
  };
  for (const e of events) {
    if (e.allDay) { allDay.push(e); continue; }
    rows.push({ hm: torontoHM(e.start), end: e.end ? torontoHM(e.end) : "", title: e.title, sub: e.location ?? "", kind: "event" });
  }
  for (const line of scheduleLines) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*[—–-]\s*(.*)$/.exec(line);
    if (m) rows.push({ hm: `${m[1].padStart(2, "0")}:${m[2]}`, title: m[3], kind: "schedule" });
  }
  const rem = getReminders();
  for (const [id, when] of Object.entries(rem)) {
    if (!String(when).startsWith(date)) continue;
    const t = ctx.state.store.getRow("tasks", id);
    if (!t || t.archived) continue;
    rows.push({ hm: String(when).slice(11, 16), title: t.title, kind: "task", ref: `tasks:${id}`, done: !!t.done });
  }
  rows.sort((a, b) => a.hm.localeCompare(b.hm));
  const today = ctx.todayToronto();
  const nowHM = date === today ? torontoHM(new Date().toISOString()) : null;
  let nowPlaced = !nowHM;
  const body = [];
  for (const r of rows) {
    if (!nowPlaced && r.hm > nowHM) { body.push(`<div class="tl-now" aria-label="Now"><span>${nowHM}</span></div>`); nowPlaced = true; }
    const past = nowHM && r.hm < nowHM;
    const title = r.ref ? `<span class="row-title" data-open="${r.ref}">${esc(r.title)}</span>` : `<span class="tl-title">${esc(r.title)}</span>`;
    body.push(`<div class="tl-row tl-${r.kind}${past ? " tl-past" : ""}${r.done ? " tl-done" : ""}"><span class="tl-time">${esc(r.hm)}${r.end ? `<small>–${esc(r.end)}</small>` : ""}</span><span class="tl-dot"></span><span class="tl-main">${title}${r.sub ? `<span class="muted tl-sub">${esc(r.sub)}</span>` : ""}</span></div>`);
  }
  if (!nowPlaced && rows.length) body.push(`<div class="tl-now"><span>${nowHM}</span></div>`);
  const allDayHtml = allDay.length ? `<div class="tl-allday">${allDay.map((e) => `<span class="tl-chip">${esc(e.title)}</span>`).join("")}</div>` : "";
  const empty = !rows.length && !allDay.length
    ? `<p class="muted">${eventsStatus === "loading" ? "Loading the calendar…" : "Nothing scheduled. Add a time to a task (“call Sam 3pm”) or a schedule entry and it shows here."}</p>`
    : "";
  return `${allDayHtml}<div class="timeline">${body.join("")}</div>${empty}`;
}

// ---------------------------------------------------------------
// Header: sync pill + page title
// ---------------------------------------------------------------
function updateSyncPill() {
  const btn = document.getElementById("sync-btn");
  if (!btn) return;
  const s = ctx.state;
  const out = s.engine ? s.engine.outboxCount() : 0;
  const conf = s.engine ? s.engine.listConflicts().length : 0;
  let label = "Synced", st = "ok";
  if (s.syncing) { label = "Syncing…"; st = "busy"; }
  else if (!navigator.onLine) { label = out ? `Offline · ${out}` : "Offline"; st = "off"; }
  else if (!s.token) { label = "Not connected"; st = "off"; }
  else if (s.persistError || conf || s.lastError) { label = "Needs attention"; st = "warn"; }
  else if (out) { label = `${out} to sync`; st = "pending"; }
  else if (!s.lastSync) { label = "Sync now"; st = "idle"; }
  btn.dataset.state = st;
  const span = btn.querySelector("span:not(.sync-dot)");
  if (span && span.textContent !== label) span.textContent = label;
  const full = ctx.statusLine?.() ?? label;
  btn.title = `${full}\nClick to sync now.`;
  btn.setAttribute("aria-label", `${full}. Sync now`);
}

function updatePageTitle() {
  const h = document.querySelector(".topbar h1");
  if (!h) return;
  const s = ctx.state;
  const label = s.itemView ? (ctx.tabLabel?.(s.tab) ?? "DashBen") : (ctx.tabLabel?.(s.tab) ?? "DashBen");
  if (h.textContent !== label) h.textContent = label;
  document.title = label === "DashBen" ? "DashBen" : `${label} · DashBen`;
}

// ---------------------------------------------------------------
// Accent colour (ui_prefs "accent") + system bars
// ---------------------------------------------------------------
export const ACCENTS = [["", "Theme default"], ["#5e6ad2", "Indigo"], ["#2f80ed", "Blue"], ["#0ea5a4", "Teal"], ["#2f9e44", "Green"], ["#d97706", "Amber"], ["#e5484d", "Red"], ["#c2410c", "Ember"], ["#a855f7", "Violet"]];
let accentApplied = null;
function applyAccent() {
  let a = "";
  try { a = ctx.state.store?.getPref("accent") ?? ""; } catch { a = ""; }
  if (!a) { try { a = localStorage.getItem("dashben-accent") ?? ""; } catch { a = ""; } }
  if (!ctx.state.store) return;
  if (a === accentApplied) return;
  accentApplied = a;
  const root = document.documentElement.style;
  if (a && /^#[0-9a-f]{6}$/i.test(a)) {
    root.setProperty("--primary", a);
    root.setProperty("--accent", a);
    root.setProperty("--primary-light", `color-mix(in srgb, ${a} 70%, white)`);
  } else {
    root.removeProperty("--primary"); root.removeProperty("--accent"); root.removeProperty("--primary-light");
  }
  try { localStorage.setItem("dashben-accent", a); } catch { /* private mode */ }
}

export function accentPickerHtml() {
  const cur = ctx.state.store?.getPref("accent") ?? "";
  return `<h4 class="mgmt-sub">Accent colour</h4><div class="accent-grid">${ACCENTS.map(([v, label]) => `<button type="button" class="accent-swatch${v === cur ? " on" : ""}" data-accent="${v}" title="${label}" aria-label="${label}"${v ? ` style="--sw:${v}"` : ""}>${v ? "" : "Aa"}</button>`).join("")}</div>`;
}

let barsSig = "";
function syncSystemBars() {
  const plug = window.Capacitor?.Plugins?.SystemBars;
  if (!plug?.set) return;
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--panel").trim() || "#121318";
  const light = (cs.colorScheme || "").includes("light") && !(cs.colorScheme || "").includes("dark");
  const sig = `${bg}|${light}`;
  if (sig === barsSig) return;
  barsSig = sig;
  try { plug.set({ color: toHex(bg), light }); } catch { /* old APK without the plugin */ }
}
function toHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return "#121318";
  return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------
// Back button (shell): close the top-most layer, then step back
// ---------------------------------------------------------------
function handleBack() {
  try {
    if (wikiAc.root && !wikiAc.root.hidden) { closeWikiAc(); return true; }
    const lb = document.querySelector(".lightbox");
    if (lb) { lb.remove(); return true; }
    const pal = document.getElementById("palette-root");
    if (pal && pal.innerHTML.trim()) { pal.innerHTML = ""; return true; }
    const fab = document.getElementById("fab-menu");
    if (fab && !fab.hidden) { fab.hidden = true; return true; }
    const pop = document.getElementById("popup-root");
    if (pop && pop.innerHTML.trim()) { (ctx.savePopupAndClose ?? ctx.closePopup)(); return true; }
    const side = document.getElementById("sidebar");
    if (side?.classList.contains("open")) { side.classList.remove("open"); return true; }
    if (ctx.state.itemView) { history.back(); return true; }
  } catch { /* fall through: let Android handle it */ }
  return false;
}

// ---------------------------------------------------------------
// Swipe left/right on the Daily header to change day (phones)
// ---------------------------------------------------------------
function installDaySwipe() {
  let sx = 0, sy = 0, armed = false;
  document.addEventListener("touchstart", (e) => {
    armed = !!e.target.closest?.(".daily-head, .timeline, .daily-swipe") && !e.target.closest?.(".row, input, textarea, select");
    if (!armed) return;
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (!armed) return;
    armed = false;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
    const btn = document.querySelector(`.daily-head [data-daily-shift="${dx < 0 ? 1 : -1}"]`);
    btn?.click();
  }, { passive: true });
}

// ---------------------------------------------------------------
// Delegated handlers
// ---------------------------------------------------------------
function onDocClick(e) {
  const dt = e.target.closest?.(".daily-title");
  if (dt) {
    const input = dt.querySelector("input[type=date]");
    if (input) { e.preventDefault(); try { input.showPicker(); } catch { input.focus(); } }
    return;
  }
  const wl = e.target.closest?.("a[data-wikilink]");
  if (wl) { e.preventDefault(); e.stopPropagation(); openWikilink(wl); return; }
  const acc = e.target.closest?.("[data-accent]");
  if (acc) {
    ctx.state.store.setPref("accent", acc.dataset.accent);
    ctx.saveBytes();
    ctx.render();
    return;
  }
  const clr = e.target.closest?.("[data-reminder-clear]");
  if (clr) {
    setReminder(clr.dataset.reminderClear, null);
    const input = clr.parentElement?.querySelector("[data-reminder]");
    if (input) input.value = "";
    clr.remove();
  }
}

function onDocChange(e) {
  const r = e.target.closest?.("[data-reminder]");
  if (r) setReminder(r.dataset.reminder, r.value || null);
}

function onDocInput(e) {
  const ta = e.target;
  if (!(ta instanceof HTMLTextAreaElement)) return;
  if (!ta.closest(".md-editor") && !ta.matches("[data-wiki-ac], textarea[name=body], textarea[name=jot]")) return;
  const info = wikiQueryAt(ta);
  if (info) showWikiAc(ta, info); else closeWikiAc();
}

function onDocKeydown(e) {
  if (!wikiAc.root || wikiAc.root.hidden || e.target !== wikiAc.ta) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); e.stopImmediatePropagation();
    const n = wikiAc.items.length;
    wikiAc.idx = (wikiAc.idx + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    paintWikiAc();
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault(); e.stopImmediatePropagation();
    pickWiki(wikiAc.idx);
  } else if (e.key === "Escape") {
    e.preventDefault(); e.stopImmediatePropagation();
    closeWikiAc();
  }
}

// Friendly due dates (stamp eu): Today / Tomorrow / Wed / Nov 12,
// plus the reminder time when one is set. The ISO date stays in the
// title attribute.
export function dueLabel(t) {
  if (!t?.due_date) return "No due date";
  const today = ctx?.todayToronto?.() ?? new Date().toISOString().slice(0, 10);
  const d = new Date(`${t.due_date}T12:00:00Z`);
  const diff = Math.round((d - new Date(`${today}T12:00:00Z`)) / 86400000);
  let label;
  if (Number.isNaN(diff)) label = t.due_date;
  else if (diff === 0) label = "Today";
  else if (diff === 1) label = "Tomorrow";
  else if (diff === -1) label = "Yesterday";
  else if (diff > 1 && diff < 7) label = new Intl.DateTimeFormat("en-CA", { weekday: "short", timeZone: "UTC" }).format(d);
  else {
    const sameYear = d.getUTCFullYear() === new Date(`${today}T12:00:00Z`).getUTCFullYear();
    label = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" }).format(d);
  }
  const rem = ctx?.state?.store ? getReminders()[t.id] : null;
  if (rem && String(rem).startsWith(t.due_date)) {
    const [h, m] = String(rem).slice(11, 16).split(":").map(Number);
    label += ` · ${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
  }
  return esc(label);
}
