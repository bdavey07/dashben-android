// PKM client (live only) on sql.js + SyncEngine + LocalStore. It
// syncs against the real Worker; the token lives only in this
// browser's localStorage (from earlier setup) and is never sent
// anywhere except the sync host.
import { SqlJsDb } from "./db-adapter.mjs";
import { SyncEngine, SYNC_TABLES } from "./sync-engine.mjs";
import { LocalStore, recurrenceSummary, parseRecurrence } from "./local-store.mjs";
import { HttpTransport } from "./transport.mjs";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function ymdAdd(ymd, n) { const t = new Date(ymd + "T12:00:00"); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); }
const todayToronto = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// --- Shell (Capacitor) native bridges ---
// Accessed via the injected window.Capacitor runtime with
// registerPlugin proxies, so no bundler imports are needed. Every
// call is best-effort: outside the shell (plain browser) all three
// are null and the web paths (localStorage / IndexedDB) apply.
// NOTE (shell variant): this www/ copy diverges from the canonical
// web client on purpose — native file persistence, secure token
// storage, and share-intent capture exist only in the shell build.
const Cap = typeof window !== "undefined" ? window.Capacitor : null;
// registerPlugin is proxied, but a bridge oddity at module load must
// never kill the whole script before boot() runs — hence safePlugin.
function safePlugin(name) {
  // No bundler here, so @capacitor/core's registerPlugin does not
  // exist in the page. The native side injects ready-made plugin
  // objects at Capacitor.Plugins.<name> (JSExport) — use those.
  // (Stamps cb–cg chased a phantom "bridge timing" bug that was
  // actually this missing function; every native feature silently
  // fell back to web storage, and the widgets starved.)
  try {
    if (!Cap) return null;
    if (Cap.Plugins && Cap.Plugins[name]) return Cap.Plugins[name];
    if (typeof Cap.registerPlugin === "function") return Cap.registerPlugin(name);
    return null;
  } catch { return null; }
}
let NativeFS = safePlugin("Filesystem");
// The native bridge can lag module evaluation; proxies captured
// too early come back null and every native feature silently falls
// back (stamp cf — this is why the widget snapshot never wrote).
// Re-resolve at boot, when the bridge is certainly up.
function resolveNativePlugins() {
  NativeFS ??= safePlugin("Filesystem");
  NativeSS ??= safePlugin("SecureStoragePlugin");
  NativeShare ??= safePlugin("ShareIntent");
  NativeNotify ??= safePlugin("LocalNotifications");
  NativeLock ??= safePlugin("AppLock");
  NativeWidget ??= safePlugin("WidgetBridge");
}
let NativeSS = safePlugin("SecureStoragePlugin");
let NativeShare = safePlugin("ShareIntent");
// A native bridge call must never hang boot: race every native call
// against a timeout so a wedged plugin falls back instead of
// freezing the loading screen. (Added Nov 3 after APK #2 stuck on
// "Loading local database" on Ben's phone.)
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`native timeout: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
// The real SQLite file on disk (sql.js exportBytes() IS the SQLite
// file format). M6 widgets read this same file from the app sandbox.
const DB_FILE = "pkm.db";
const bytesToB64 = (bytes) => {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(out);
};
const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
// Export hook (stamp 2026-11-04j, shell only): the shared exportDb()
// calls this when present, so the backup lands in Documents instead of
// a blob download (which the WebView cannot perform).
window.__dashbenExportDb = async (name, bytes) => {
  await withTimeout(NativeFS.writeFile({ path: name, data: bytesToB64(bytes), directory: "DOCUMENTS" }), 10000, "fs.exportWrite");
};
// --- Due reminders (stamp 2026-11-04r, shell only) ---
// Local notifications at 9 a.m. on each task's due day, plus one
// morning digest while anything is overdue. Recomputed at boot and
// after every sync (via window.__dashbenAfterSync). On by default;
// Management > Sync turns them off (ui_prefs "reminders" = "off").
let NativeNotify = safePlugin("LocalNotifications");
let remindersBusy = false;
function remindersOn() { return state.store?.getRow("ui_prefs", "reminders")?.value !== "off"; }
function setRemindersPref(on) {
  const ts = new Date().toISOString();
  state.engine.localWrite("ui_prefs", { key: "reminders", value: on ? "on" : "off", updated_at: ts }, { baseUpdatedAt: state.store.getRow("ui_prefs", "reminders")?.updated_at ?? null });
}
function reminderIdFor(taskId) { let h = 7; for (let i = 0; i < taskId.length; i++) h = ((h * 31) + taskId.charCodeAt(i)) | 0; return (Math.abs(h) % 1900000000) + 1; }
async function cancelAllReminders() {
  if (!NativeNotify) return;
  try {
    const pending = await withTimeout(NativeNotify.getPending(), 5000, "notify.pending");
    if (pending?.notifications?.length) await withTimeout(NativeNotify.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) }), 5000, "notify.cancel");
  } catch { /* best-effort */ }
}
async function scheduleReminders() {
  if (remindersBusy || !state.store || !NativeNotify) return;
  remindersBusy = true;
  try {
    if (!remindersOn()) return;
    const perm = await withTimeout(NativeNotify.checkPermissions(), 5000, "notify.check").catch(() => null);
    if (!perm || perm.display !== "granted") return;
    const today = todayToronto();
    const d = new Date(today + "T12:00:00");
    d.setDate(d.getDate() + 1);
    const tomorrow = d.toISOString().slice(0, 10);
    const now = new Date();
    const at9 = (dateStr) => new Date(dateStr + "T09:00:00");
    const due = openTasks().filter((t) => t.due_date && t.due_date <= tomorrow);
    const notes = [];
    const overdue = due.filter((t) => t.due_date < today);
    if (overdue.length) {
      let when = at9(today);
      if (when <= now) when = at9(tomorrow);
      notes.push({ id: 1900000001, title: "DashBen \u2014 overdue", body: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}. First up: ${overdue[0].title}`, schedule: { at: when, allowWhileIdle: true }, actionTypeId: "TASK_ACTIONS", extra: { taskId: overdue[0].id } });
    }
    for (const t of due) {
      if (t.due_date < today) continue;
      const when = at9(t.due_date);
      if (when <= now) continue;
      notes.push({ id: reminderIdFor(t.id), title: "Due today", body: t.title, schedule: { at: when, allowWhileIdle: true }, actionTypeId: "TASK_ACTIONS", extra: { taskId: t.id } });
    }
    await cancelAllReminders();
    if (notes.length) await withTimeout(NativeNotify.schedule({ notifications: notes.slice(0, 24) }), 8000, "notify.schedule");
  } catch { /* reminders are best-effort */ } finally { remindersBusy = false; }
}

const pendingNotifActions = [];
function applyNotifAction(act, id) {
  const t = state.store?.getRow("tasks", id);
  if (!t) return;
  if (act === "done") { if (!t.done) state.store.completeTask(id, todayToronto()); }
  else if (!t.done) {
    const today = todayToronto();
    const base = t.due_date && t.due_date > today ? t.due_date : today;
    state.store.updateProps("tasks", id, { due_date: ymdAdd(base, 1) });
  }
  buzz(); render(); saveBytes(); void scheduleReminders();
}
let widgetDoneDraining = false;
// Widget checkbox completions land here: the widget records the
// ids natively (pending_done) so the tick is visible instantly;
// the app applies them through the real store (recurrence spawns,
// sync logs) at boot, after syncs, and on foreground.
async function processWidgetDone() {
  if (!NativeShare || widgetDoneDraining || !state.booted || !state.store) return;
  widgetDoneDraining = true;
  try {
    const r = await withTimeout(NativeShare.getPendingDone({}), 3000, "share.pendingDone").catch(() => null);
    const ids = Array.isArray(r?.ids) ? r.ids : [];
    if (!ids.length) return;
    await withTimeout(NativeShare.clearPendingDone({}), 3000, "share.clearDone").catch(() => null);
    for (const id of ids) applyNotifAction("done", id);
    queueWidgetSnapshot();
  } finally { widgetDoneDraining = false; }
}
function processPendingNotifActions() {
  if (!state.booted || !state.store || !pendingNotifActions.length) return;
  for (const { act, id } of pendingNotifActions.splice(0)) applyNotifAction(act, id);
}
async function initReminders() {
  if (!NativeNotify) return;
  window.__dashbenAfterSync = () => { void scheduleReminders(); processPendingNotifActions(); void processWidgetDone(); queueWidgetSnapshot(); setTimeout(queueWidgetSnapshot, 3000); };
  try {
    await NativeNotify.registerActionTypes({ types: [{ id: "TASK_ACTIONS", actions: [{ id: "done", title: "Done" }, { id: "snooze", title: "Snooze 1 day" }] }] });
  } catch { /* older plugin build: plain taps still work */ }
  try {
    await NativeNotify.addListener("localNotificationActionPerformed", (ev) => {
      const id = ev?.notification?.extra?.taskId;
      const act = ev?.actionId;
      if (id && (act === "done" || act === "snooze")) { pendingNotifActions.push({ act, id }); processPendingNotifActions(); return; }
      if (id && state.store?.getRow("tasks", id)) { state.itemView = null; state.tab = "tasks"; saveTab(); render(); openTaskPopup(id); }
    });
  } catch { /* listener is a nicety */ }
  try {
    if (remindersOn()) {
      const perm = await withTimeout(NativeNotify.checkPermissions(), 5000, "notify.check").catch(() => null);
      if (perm && perm.display === "prompt") await withTimeout(NativeNotify.requestPermissions(), 8000, "notify.request").catch(() => null);
    }
  } catch { /* permission is best-effort */ }
  await scheduleReminders();
}

// --- App lock (stamp 2026-11-04ca, shell only) ---
// Optional fingerprint/PIN lock (Management > App lock), off by
// default. Device-local flag (never synced): localStorage
// "dashben-applock". Locks on app start and after >60 s in the
// background. Native side: AppLockPlugin (framework BiometricPrompt
// with device-credential fallback).
let NativeLock = safePlugin("AppLock");
function appLockOn() { try { return localStorage.getItem("dashben-applock") === "1"; } catch { return false; } }
function setAppLock(on) { try { localStorage.setItem("dashben-applock", on ? "1" : "0"); } catch { /* ignore */ } }
let unlockBusy = false;
async function tryUnlock(el) {
  if (unlockBusy) return;
  unlockBusy = true;
  const msg = el.querySelector("[data-lock-msg]");
  try {
    const r = await withTimeout(NativeLock.authenticate({}), 120000, "lock.auth");
    if (r?.ok) { el.remove(); document.body.classList.remove("app-locked"); }
    else if (msg) msg.textContent = r?.message || "Unlock failed \u2014 tap Unlock to try again.";
  } catch { if (msg) msg.textContent = "Unlock failed \u2014 tap Unlock to try again."; }
  unlockBusy = false;
}
function maybeLockApp() {
  if (!NativeLock || !appLockOn() || document.querySelector("#lock-screen")) return;
  const el = document.createElement("div");
  el.id = "lock-screen";
  el.innerHTML = `<div class="lock-card"><div class="lock-title">\uD83D\uDD12 DashBen</div><p class="muted">Locked \u2014 unlock to continue.</p><button type="button" class="primary-btn" data-unlock>Unlock</button><p class="muted" data-lock-msg></p></div>`;
  document.body.appendChild(el);
  document.body.classList.add("app-locked");
  el.querySelector("[data-unlock]")?.addEventListener("click", () => void tryUnlock(el));
  void tryUnlock(el);
}
let shellHiddenAt = 0;

// --- Home-screen widgets (M6, stamp 2026-11-04cb, shell only) ---
// The web client composes a small JSON snapshot after every sync
// and writes it to widget.json in the app files dir; the native
// Today widget renders it and asks for a redraw via WidgetBridge.
// Read-only by design \u2014 widget taps open the app (task taps land
// on the task popup through the ShareIntent widget channel).
let NativeWidget = safePlugin("WidgetBridge");
let lastWidgetJson = "", widgetSnapTimer = null;
function famWhenLabel(e, today) {
  const day = e.allDay ? e.start : torontoYmdOf(e.start);
  const rel = day === today ? "Today" : day === ymdAdd(today, 1) ? "Tomorrow" : new Date(day + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short" });
  if (e.allDay) return rel;
  return rel + " " + new Date(e.start).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}
function buildWidgetSnapshot() {
  const today = todayToronto();
  const open = openTasks();
  const overdue = open.filter((t) => t.due_date && t.due_date < today).sort((a, b) => a.due_date < b.due_date ? -1 : 1);
  const dueToday = open.filter((t) => t.due_date === today);
  const rows = [];
  for (const t of overdue.slice(0, 10)) rows.push({ id: t.id, kind: "overdue", text: t.title, meta: new Date(t.due_date + "T12:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric" }) });
  for (const t of dueToday.slice(0, 20 - rows.length)) rows.push({ id: t.id, kind: "today", text: t.title, meta: t.priority || "" });
  let family = null, familyList = [];
  try {
    const fam = famSeed();
    const nowIso = new Date().toISOString();
    const ups = (fam.events ?? []).filter((e) => e.allDay ? e.end > today : e.end > nowIso)
      .sort((a, b) => (a.allDay ? a.start + "T00:00:00" : a.start) < (b.allDay ? b.start + "T00:00:00" : b.start) ? -1 : 1)
      .slice(0, 10);
    familyList = ups.map((e) => ({ title: e.title, when: famWhenLabel(e, today) }));
    if (familyList.length) family = { title: familyList[0].title, when: familyList[0].when };
  } catch { /* family is optional in the snapshot */ }
  let schedule = [];
  try {
    const note = dailyNoteFor(today);
    if (note) schedule = splitSchedule(note.body_markdown ?? "").schedule.slice(0, 10).map((l) => l.trim());
  } catch { /* schedule is optional in the snapshot */ }
  let weather = "";
  if (state.weather) {
    const days = state.weather.daily;
    const { icon, condition } = weatherIcon(days.weathercode?.[0] ?? -1);
    weather = `${icon} ${Math.round(days.temperature_2m_max?.[0] ?? 0)}\u00B0 / ${Math.round(days.temperature_2m_min?.[0] ?? 0)}\u00B0 \u00B7 ${condition} \u00B7 ${Math.round(state.weather.current.temperature_2m)}\u00B0 now \u00B7 Mitchell`;
  }
  let wx = null;
  if (state.weather) {
    const cur = state.weather.current ?? {}, d = state.weather.daily ?? {};
    wx = {
      temp: `${Math.round(cur.temperature_2m ?? 0)}\u00B0`,
      feels: cur.apparent_temperature != null ? `${Math.round(cur.apparent_temperature)}\u00B0` : "\u2014",
      wind: cur.wind_speed_10m != null ? `${Math.round(cur.wind_speed_10m)} km/h` : "\u2014",
      pop: d.precipitation_probability_max?.[0] != null ? `${Math.round(d.precipitation_probability_max[0])}%` : "\u2014",
      psum: d.precipitation_sum?.[0] != null ? `${Math.round(d.precipitation_sum[0] * 10) / 10} mm` : "\u2014",
    };
  }
  return { at: Date.now(), overdueCount: overdue.length, todayCount: dueToday.length, rows, family, familyList, weather, schedule, wx };
}
let lastSnapAttempt = 0;
function writeWidgetSnapshotThrottled() {
  const now = Date.now();
  if (now - lastSnapAttempt < 2500) return;
  lastSnapAttempt = now;
  void writeWidgetSnapshot();
}
async function writeWidgetSnapshot() {
  try { localStorage.setItem("dashben-widget-status", `attempted @ ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`); } catch { /* ignore */ }
  if (!NativeFS) NativeFS = safePlugin("Filesystem");
  if (!NativeFS) { try { localStorage.setItem("dashben-widget-status", "attempted \u2014 file plugin missing"); } catch { /* ignore */ } return; }
  try {
    const snap = buildWidgetSnapshot();
    const { at, ...rest } = snap;
    const restJson = JSON.stringify(rest);
    if (restJson === lastWidgetJson) return;
    await withTimeout(NativeFS.writeFile({ path: "widget.json", data: bytesToB64(new TextEncoder().encode(JSON.stringify(snap))), directory: "DATA" }), 5000, "fs.widget");
    lastWidgetJson = restJson; // only gate after a write that landed (stamp cd)
    try { localStorage.setItem("dashben-widget-status", `ok @ ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`); } catch { /* ignore */ }
    if (NativeWidget) await withTimeout(NativeWidget.refresh({}), 5000, "widget.refresh").catch(() => null);
  } catch (e) {
    try { localStorage.setItem("dashben-widget-status", `FAILED: ${e?.message ?? e}`); } catch { /* ignore */ }
  }
}
function queueWidgetSnapshot() {
  if (widgetSnapTimer) clearTimeout(widgetSnapTimer);
  widgetSnapTimer = setTimeout(() => { widgetSnapTimer = null; void writeWidgetSnapshot(); }, 600);
}
async function checkWidgetAction() {
  if (!NativeShare) return;
  try {
    const r = await withTimeout(NativeShare.getWidgetAction({}), 3000, "share.widget");
    const act = r?.action;
    if (!act) return;
    try { localStorage.setItem("dashben-last-widget-action", `${act}${r.taskId ? " " + r.taskId.slice(0, 8) : ""} @ ${new Date().toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}`); } catch { /* ignore */ }
    if (act === "task-open" && r.taskId && state.store?.getRow("tasks", r.taskId)) {
      state.itemView = null; state.tab = "tasks"; saveTab(); render(); openTaskPopup(r.taskId);
    } else if (act === "capture" || act === "task" || act === "note") {
      document.querySelector(`[data-fab-menu="${act}"]`)?.click();
    }
  } catch { /* widget actions are best-effort */ }
}

// Phone slimming (stamp au): the footer sync status stays hidden
// unless the outbox or conflicts actually need attention.
try {
  const ssEl = document.querySelector("#sync-status");
  if (ssEl && typeof MutationObserver === "function") {
    const updSs = () => {
      const t = ssEl.textContent || "";
      const bad = Number((/outbox (\d+)/.exec(t) || [])[1] || 0) > 0 || Number((/conflicts (\d+)/.exec(t) || [])[1] || 0) > 0 || /error/i.test(t);
      ssEl.style.display = bad ? "" : "none";
    };
    new MutationObserver(updSs).observe(ssEl, { childList: true, characterData: true, subtree: true });
    updSs();
  }
} catch { /* cosmetic only */ }

// Bottom-bar Daily button (stamps ax, bf): originally opened today's
// daily-note popup; at Ben's direction it is now a plain tab button
// (data-tab="daily") — no popup-opening handler remains.

const SCHEMA_URL = "./schema.sql";
const BOOT_T0 = typeof performance !== "undefined" ? performance.now() : 0;
const state = {
  db: null, engine: null, store: null, transport: null,
  base: "https://pkm.ben-cloud.net", token: "",
  tab: "dashboard", dailyDate: null, weather: null, weatherTried: false, weatherDay: null, itemView: null,
  lastSync: null, lastError: null, booted: false,
};

// Managed-field vocabularies (server defaults; field_values rows
// come first in saved order, then the rest A-Z — same rule as the
// server dropdowns).
const DEFAULTS = {
  "tasks.priority": ["P1", "P2", "P3", "P4"],
  "tasks.project": ["Inbox", "General", "Finances", "Projects", "Stuff to Buy", "Home", "Ideas"],
  "notes.type": ["Meeting Notes", "Concerns", "General Notes", "Research Notes", "Briefs"],
  "people.role": ["Family", "Council colleague", "Candidate", "Community contact", "Donor", "Personal contact", "Resident"],
  "reading_items.status": ["To read", "Reading", "Read"],
  "projects.status": ["Not started", "In progress", "Waiting", "Done"],
  "projects.category": [],
};
function vocabValues(objectType, field) {
  const key = `${objectType}.${field}`;
  const defaults = DEFAULTS[key] ?? [];
  const saved = state.db.prepare("SELECT value FROM field_values WHERE object_type=? AND field=? ORDER BY rowid").all(objectType, field).map((r) => r.value);
  const rest = saved.filter((v) => !defaults.includes(v)).sort();
  return [...defaults, ...rest];
}
function vocabOptions(objectType, field, current) {
  const vals = vocabValues(objectType, field);
  if (current && !vals.includes(current)) return [current, ...vals];
  return vals;
}
function saveTab() {
  try {
    const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    s.tab = state.tab;
    localStorage.setItem("pkm-local-settings", JSON.stringify(s));
  } catch {}
}

// --- IndexedDB persistence (sqlite bytes) ---
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("pkm-local", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function loadBytes() {
  // Shell: the native DB file is the durable store (and the file M6
  // widgets will read). IndexedDB stays as fallback for databases
  // created by the proof build, which had no file yet.
  if (NativeFS) {
    try {
      const r = await withTimeout(NativeFS.readFile({ path: DB_FILE, directory: "DATA" }), 5000, "fs.readFile");
      if (r && r.data) return b64ToBytes(r.data);
    } catch { /* no file yet */ }
  }
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const tx = db.transaction("files", "readonly").objectStore("files").get("db");
      tx.onsuccess = () => resolve(tx.result ?? null);
      tx.onerror = () => resolve(null);
    });
  } catch { return null; }
}
// Persistence coalescing (stamp bz): every edit used to serialize
// and write the whole database immediately; bursts (bulk actions,
// sync applies) now collapse into one write ~150 ms after the last
// change, with a trailing write if edits land while one is in
// flight. saveBytes(true) flushes promptly for callers that need
// the write landed before they proceed (e.g. before a reload).
let saveChain = Promise.resolve(), saveScheduled = false, saveAgain = false;
function saveBytes(flush = false) {
  if (flush) { saveChain = saveChain.catch(() => {}).then(() => persistBytesNow()); return saveChain; }
  if (saveScheduled) { saveAgain = true; return saveChain; }
  saveScheduled = true;
  saveChain = saveChain.catch(() => {}).then(async () => {
    await new Promise((r) => setTimeout(r, 150));
    saveScheduled = false;
    await persistBytesNow();
    if (saveAgain) { saveAgain = false; void saveBytes(); }
  });
  return saveChain;
}
async function persistBytesNow() {
  if (!state.db) return;
  const bytes = state.db.exportBytes();
  if (NativeFS) {
    try {
      await withTimeout(NativeFS.writeFile({ path: DB_FILE, data: bytesToB64(bytes), directory: "DATA" }), 5000, "fs.writeFile");
    } catch { /* file persistence is best-effort */ }
  }
  try {
    const db = await idb();
    await new Promise((resolve) => {
      const tx = db.transaction("files", "readwrite").objectStore("files").put(bytes, "db");
      tx.oncomplete = resolve; tx.onerror = resolve;
    });
  } catch { /* persistence is best-effort */ }
}

// --- Settings ---
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    state.base = s.base || state.base;
    state.token = s.token || "";
  } catch { /* defaults */ }
}

// Shell: the sync token lives in Keystore-backed secure storage,
// not localStorage. On first run after the proof build, a token
// previously set via console is migrated once into secure storage
// and cleared from localStorage. (No token-entry UI yet — sync
// testing is waived for now; the prompt is a later step.)
async function loadSecureToken() {
  if (!NativeSS) return;
  try {
    const r = await withTimeout(NativeSS.get({ key: "sync-token" }), 5000, "ss.get");
    if (r && r.value) { state.token = r.value; return; }
  } catch { /* no stored token */ }
  try {
    const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    if (s.token) {
      await withTimeout(NativeSS.set({ key: "sync-token", value: s.token }), 5000, "ss.set");
      state.token = s.token;
      delete s.token;
      localStorage.setItem("pkm-local-settings", JSON.stringify(s));
    }
  } catch { /* migration is best-effort */ }
}

// --- Sync ---
// Swap only the sync button's text span so its icon survives (the
// collapsed sidebar shows the icon alone; a textContent rewrite used
// to destroy the svg on the first sync).
function syncBtnLabel(txt) {
  const b = $("#sync-btn");
  if (!b) return;
  const span = b.querySelector?.("span");
  if (span) span.textContent = txt;
  else b.textContent = txt;
}
async function doSync() {
  if (state.syncing) return;
  state.syncing = true;
  const btn = $("#sync-btn");
  btn.disabled = true;
  syncBtnLabel("Syncing…");
  try {
    if (!state.booted) {
      await state.engine.firstSync(state.transport);
    } else {
      await state.engine.sync(state.transport);
    }
    state.booted = true;
    state.lastSync = new Date().toLocaleTimeString();
    state.lastError = null;
    state.searchDirty = true;
  } catch (e) {
    state.lastError = e.message;
  }
  state.syncing = false;
  btn.disabled = false;
  syncBtnLabel("Sync now");
  render();
  saveBytes();
  if (typeof window !== "undefined") window.__dashbenAfterSync?.();
  loadFamilyCalendar();
  loadFeed();
  if (state.feedReload) { state.feedReload = false; loadFeed(true); }
}

// Full re-download: pushes any pending local edits first (so they
// survive), then pulls the complete server snapshot. Fixes a client
// that only ever synced incrementally and is therefore missing rows
// that predate the change log — anything never edited in the new app
// has no sync_changes entry, so incremental sync can never deliver
// it (notably: people, untouched notes/reading). Upsert-only —
// nothing local is deleted.
async function doFullSync() {
  try {
    if (state.booted) { try { await state.engine.sync(state.transport); } catch { /* best-effort push; snapshot still fixes missing rows */ } }
    await state.engine.firstSync(state.transport);
    state.booted = true;
    state.lastSync = new Date().toLocaleTimeString();
    state.lastError = null;
    state.searchDirty = true;
  } catch (e) {
    state.lastError = e.message;
  }
  render();
  saveBytes();
}

// Stamp cw: one-tap sync health check. Compares every synced table's
// local row count against the server's snapshot count, and reports the
// outbox (edits waiting to upload), recorded conflicts, and the last
// successful sync. A mismatch with a non-empty outbox usually just
// means unpushed edits; a mismatch with an empty outbox means drift.
async function runHealthCheck() {
  const count = (t) => { try { return state.db.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).all()[0]?.c ?? null; } catch { return null; } };
  const outbox = count("sync_outbox");
  const conflicts = count("sync_conflicts");
  const rows = [];
  let mismatches = 0, errors = 0;
  for (const t of SYNC_TABLES) {
    const lc = count(t);
    let sc = null;
    try {
      let cursor = null, total = 0, guard = 0;
      do { const page = await state.transport.snapshot(t, cursor); total += (page.rows ?? []).length; cursor = page.next_cursor; } while (cursor && ++guard < 60);
      sc = total;
    } catch { errors++; }
    if (sc === null) { rows.push(`<p class="muted">${esc(t)}: this device ${lc ?? "?"} \u00b7 server unreachable</p>`); continue; }
    const ok = lc === sc;
    if (!ok) mismatches++;
    rows.push(`<p class="muted">${esc(t)}: this device ${lc ?? "?"} \u00b7 server ${sc} ${ok ? "\u2713" : "\u26a0"}</p>`);
  }
  const verdict = errors
    ? `Could not reach the server for ${errors} table(s) \u2014 check the connection and token.`
    : (mismatches === 0 && (outbox ?? 0) === 0 && (conflicts ?? 0) === 0)
      ? "In sync \u2014 every table matches the server, nothing waiting to upload, no conflicts."
      : "Differences found \u2014 if edits are waiting, Sync now; if they persist with an empty outbox, Re-download everything rebuilds from the server.";
  state.healthHtml = `<div class="health-box"><p><b>Health check</b> <span class="muted">${new Date().toLocaleTimeString()}</span></p><p>${verdict}</p><p class="muted">Waiting to upload: ${outbox ?? "?"} \u00b7 Conflicts: ${conflicts ?? "?"} \u00b7 Last sync: ${state.lastSync ?? "not yet this session"}</p>${rows.join("")}</div>`;
  render();
}

// Shell: collect one pending share-sheet send (if any) into the
// inbox. The native side clears after one read, so repeated calls
// are safe — boot + every return to the foreground.
async function captureSharedText() {
  if (!NativeShare || !state.store) return;
  try {
    const r = await withTimeout(NativeShare.getSharedText(), 5000, "share.get");
    const text = (r && r.text ? String(r.text) : "").trim();
    if (text) {
      if (routeCapture(text) === "inbox") state.store.captureInbox({ title: "", body: text });
      render();
      saveBytes();
    }
  } catch { /* no share pending */ }
  await captureSharedImage();
}

// Shared photos (stamp 2026-11-04s, shell only): the Java plugin
// copies a shared image into the app files dir; read it back through
// the Filesystem bridge, downscale it, and file it in the Inbox with
// the photo attached. The temp file is removed afterwards.
async function captureSharedImage() {
  if (!NativeShare || !NativeFS || !state.store) return;
  let file = "";
  try {
    const r = await withTimeout(NativeShare.getSharedImage(), 5000, "share.image");
    file = (r && r.file) ? String(r.file) : "";
    if (!file) return;
    const rd = await withTimeout(NativeFS.readFile({ path: file, directory: "DATA" }), 20000, "fs.readShared");
    const b64 = rd && typeof rd.data === "string" ? rd.data : "";
    if (!b64) return;
    const att = await dataToAttachment(b64, "image/jpeg");
    const item = state.store.captureInbox({ title: "", body: "Photo" });
    state.store.addAttachment("inbox_items", item.id, att.mime, att.data, att.name ?? null);
    state.searchDirty = true;
    render();
    saveBytes();
  } catch { /* no image share pending */ }
  if (file) { try { await NativeFS.deleteFile({ path: file, directory: "DATA" }); } catch {} }
}

function statusLine() {
  const out = state.engine ? state.engine.outboxCount() : 0;
  const conf = state.engine ? state.engine.listConflicts().length : 0;
  let s = `outbox ${out} · conflicts ${conf}`;
  if (state.lastSync) s += ` · last sync ${state.lastSync}`;
  if (state.lastError) s += ` · ERROR: ${state.lastError}`;
  return s;
}

// --- Queries (local only) ---
function openTasks() {
  return state.db.prepare("SELECT * FROM tasks WHERE archived=0 AND done=0 ORDER BY (due_date IS NULL), due_date, (created_at IS NULL), created_at").all(); // within a due date, oldest-added first (was title/alphabetical) — new tasks land at the bottom of Dashboard + Daily lists
}
function doneTasks() {
  return state.db.prepare("SELECT * FROM tasks WHERE archived=0 AND done=1 ORDER BY updated_at DESC LIMIT 50").all();
}
function allNotes() {
  return state.db.prepare("SELECT * FROM notes WHERE archived=0 ORDER BY updated_at DESC LIMIT 100").all();
}
function inboxItems() {
  return state.db.prepare("SELECT * FROM inbox_items WHERE archived=0 ORDER BY created_at DESC LIMIT 100").all();
}
function allRows(table) {
  return state.db.prepare(`SELECT * FROM ${table} WHERE archived=0 ORDER BY updated_at DESC LIMIT 100`).all();
}
function linkedTitles(fromType, fromId, relationName, toType) {
  const rels = state.db.prepare("SELECT to_id FROM relations WHERE from_type=? AND from_id=? AND relation_name=? AND to_type=?").all(fromType, fromId, relationName, toType);
  return rels.map((r) => ({ id: r.to_id, row: state.store.getRow(toType, r.to_id) })).filter((x) => x.row);
}
function backlinks(toType, toId) {
  const rels = state.db.prepare("SELECT from_type, from_id FROM relations WHERE to_type=? AND to_id=? AND relation_name='link'").all(toType, toId);
  return rels.map((r) => ({ type: r.from_type, id: r.from_id, row: state.store.getRow(r.from_type, r.from_id) })).filter((x) => x.row);
}
function forwardLinks(fromType, fromId) {
  const rels = state.db.prepare("SELECT to_type, to_id FROM relations WHERE from_type=? AND from_id=? AND relation_name='link'").all(fromType, fromId);
  return rels.map((r) => ({ type: r.to_type, id: r.to_id, row: state.store.getRow(r.to_type, r.to_id) })).filter((x) => x.row);
}

// --- Popups (P1: production opens object detail in popups) ---
function openPopup(title, inner, openRef) {
  // Editor popups get their Close button (which saves) in the header,
  // beside Pin and Open (stamp 2026-11-04u; the standalone
  // Save and Close buttons were removed in stamp at): it submits the
  // popup's form from outside via the form= attribute.
  const formTag = /<form[^>]*popup-form[^>]*>/.exec(inner)?.[0] ?? "";
  const formId = /id="([^"]+)"/.exec(formTag)?.[1] ?? "";
  const saveBtn = formId ? `<button type="submit" form="${formId}" class="primary-btn">Close</button>` : "";
  $("#popup-root").innerHTML = `<div class="popup-backdrop">
    <div class="popup-card" role="dialog" aria-label="${esc(title)}">
      <div class="popup-head"><h3>${esc(title)}</h3><div class="popup-head-actions">${saveBtn}${openRef ? `<button data-pin-toggle="${openRef}" class="ghost-btn">${isPinned(openRef) ? "Unpin" : "Pin"}</button><button data-open-page="${openRef}" class="ghost-btn">Open</button>` : ""}</div></div>
      ${inner}
    </div>
  </div>`;
  bindPopupForms();
  bindExtraPopupForms();
}
// Clicking the backdrop saves (stamp 2026-11-04aj): an editor
// popup submits its form exactly like Close; a create
// popup submits only when its title is filled, so a stray click
// cannot create an untitled item; anything else just closes.
function savePopupAndClose() {
  buzz();
  const root = $("#popup-root");
  const form = root?.querySelector?.("form.popup-form") || root?.querySelector?.("form[data-create-person-popup], form[data-create-reading-popup]");
  if (!form || typeof form.requestSubmit !== "function") { closePopup(); return; }
  if (!form.classList.contains("popup-form")) {
    const title = form.querySelector('input[name="title"]');
    if (title && !title.value.trim()) { closePopup(); return; }
  }
  form.requestSubmit();
}
function closePopup() {
  $("#popup-root").innerHTML = "";
}
function selectHtml(name, values, current, allowEmpty = true) {
  return `<select name="${name}">${allowEmpty ? `<option value="">—</option>` : ""}${values.map((v) => `<option value="${esc(v)}" ${v === current ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
}
function newValueHtml(name, placeholder) {
  return `<input name="${name}" placeholder="${placeholder}">`;
}
function tagsForm(table, id) {
  const current = state.store.listTags(table, id);
  const allTags = state.db.prepare("SELECT DISTINCT tag FROM object_tags WHERE object_type=? ORDER BY tag").all(table).map((r) => r.tag);
  return `<div data-tag-input style="position:relative">
    <div class="cf-tag-box"><span data-tag-chips style="display:flex;flex-wrap:wrap;gap:6px"></span><input type="text" data-tag-text placeholder="Type to filter tags, or create a new one" autocomplete="off"></div>
    <input type="hidden" name="tags" data-tag-value value="${esc(current.join(", "))}">
    <div class="cf-tag-list" data-tag-list hidden>
      ${allTags.map((t) => `<button type="button" data-tag-option="${esc(t)}">${esc(t)}</button>`).join("")}
      <button type="button" data-tag-create hidden>Create “<span data-tag-create-name></span>”</button>
      <p data-tag-empty hidden style="padding:8px 12px" class="muted">No matching tags.</p>
    </div>
  </div>`;
}

// Body field without its own form or save button, for popups merged
// into a single save (all popups now use this; the old bodyForm is gone).

// --- Markdown body editor (stamp 2026-11-04af) ---
// Every body field is a Markdown editor: a formatting toolbar,
// Ctrl/Cmd+B / I / K shortcuts, list continuation on Enter, Tab to
// indent, auto-grow, and a Preview toggle that renders the Markdown
// (checklist boxes in the preview tick the source lines). Bodies are
// still stored as plain Markdown — nothing about the data changes.
function mdEditorHtml(body, rows = 5, placeholder = "") {
  return `<div class="md-editor"><div class="md-toolbar" role="toolbar" aria-label="Formatting"><button type="button" data-md="bold" title="Bold (Ctrl+B)"><b>B</b></button><button type="button" data-md="italic" title="Italic (Ctrl+I)"><i>I</i></button><button type="button" data-md="strike" title="Strikethrough"><s>S</s></button><button type="button" data-md="h2" title="Heading">H2</button><button type="button" data-md="h3" title="Subheading">H3</button><button type="button" data-md="ul" title="Bullet list">\u2022 List</button><button type="button" data-md="ol" title="Numbered list">1. List</button><button type="button" data-md="check" title="Checklist">\u2611 Task</button><button type="button" data-md="quote" title="Quote">\u275d</button><button type="button" data-md="code" title="Code">&lt;/&gt;</button><button type="button" data-md="link" title="Link (Ctrl+K)">Link</button><button type="button" data-md="hr" title="Divider">\u2015</button><span class="md-spacer"></span><button type="button" data-md="preview" class="ghost-btn" title="Toggle preview">Preview</button></div><textarea name="body" rows="${rows}"${placeholder ? ` placeholder="${esc(placeholder)}"` : ""}>${esc(body ?? "")}</textarea><div class="md-preview" hidden></div></div>`;
}

function mdWrap(text, s, e, before, after) {
  if (s === e) {
    let a = s; while (a > 0 && /\S/.test(text[a - 1])) a--;
    let b = e; while (b < text.length && /\S/.test(text[b])) b++;
    s = a; e = b;
  }
  const sel = text.slice(s, e);
  if (text.slice(s - before.length, s) === before && text.slice(e, e + after.length) === after) {
    return { text: text.slice(0, s - before.length) + sel + text.slice(e + after.length), selStart: s - before.length, selEnd: e - before.length };
  }
  return { text: text.slice(0, s) + before + sel + after + text.slice(e), selStart: s + before.length, selEnd: e + before.length };
}

function mdLink(text, s, e) {
  if (s === e) {
    let a = s; while (a > 0 && /\S/.test(text[a - 1])) a--;
    let b = e; while (b < text.length && /\S/.test(text[b])) b++;
    s = a; e = b;
  }
  const sel = text.slice(s, e);
  if (/^https?:\/\/\S+$/.test(sel)) {
    const out = text.slice(0, s) + `[link text](${sel})` + text.slice(e);
    return { text: out, selStart: s + 1, selEnd: s + 10 };
  }
  const out = text.slice(0, s) + `[${sel}](https://)` + text.slice(e);
  return { text: out, selStart: s + sel.length + 3, selEnd: s + sel.length + 11 };
}

const MD_MARKER_RE = /^#{1,6}\s+|^>\s?|^[-*]\s+(\[[ xX]\]\s+)?|^\d+\.\s+/;
function mdPrefixLines(text, s, e, prefixFor, detectRe) {
  const start = text.lastIndexOf("\n", s - 1) + 1;
  let end = text.indexOf("\n", e);
  if (end === -1) end = text.length;
  const block = text.slice(start, end);
  const lines = block.split("\n");
  const allHave = lines.every((l) => detectRe.test(l));
  const out = lines.map((l, i) => allHave ? l.replace(detectRe, "") : prefixFor(i) + l.replace(MD_MARKER_RE, "")).join("\n");
  return { text: text.slice(0, start) + out + text.slice(end), selStart: start, selEnd: start + out.length };
}

function mdApply(ta, action) {
  const s = ta.selectionStart, e = ta.selectionEnd, text = ta.value;
  let r = null;
  if (action === "bold") r = mdWrap(text, s, e, "**", "**");
  else if (action === "italic") r = mdWrap(text, s, e, "*", "*");
  else if (action === "strike") r = mdWrap(text, s, e, "~~", "~~");
  else if (action === "code") r = text.slice(s, e).includes("\n")
    ? { text: text.slice(0, s) + "```\n" + text.slice(s, e) + "\n```" + text.slice(e), selStart: s + 4, selEnd: e + 4 }
    : mdWrap(text, s, e, "`", "`");
  else if (action === "link") r = mdLink(text, s, e);
  else if (action === "h2") r = mdPrefixLines(text, s, e, () => "## ", /^#{1,6}\s+/);
  else if (action === "h3") r = mdPrefixLines(text, s, e, () => "### ", /^#{1,6}\s+/);
  else if (action === "ul") r = mdPrefixLines(text, s, e, () => "- ", /^[-*]\s+/);
  else if (action === "ol") r = mdPrefixLines(text, s, e, (i) => `${i + 1}. `, /^\d+\.\s+/);
  else if (action === "check") r = mdPrefixLines(text, s, e, () => "- [ ] ", /^[-*]\s+\[[ xX]\]\s+/);
  else if (action === "quote") r = mdPrefixLines(text, s, e, () => "> ", /^>\s?/);
  else if (action === "hr") r = { text: text.slice(0, s) + "\n\n---\n" + text.slice(e), selStart: s + 5, selEnd: s + 5 };
  if (!r) return;
  ta.value = r.text;
  ta.focus();
  try { ta.setSelectionRange(r.selStart, r.selEnd); } catch {}
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// Enter inside a list line continues the list (or exits it when the
// item is empty). Returns true when it handled the keypress.
function mdContinueList(ta) {
  const pos = ta.selectionStart;
  if (pos !== ta.selectionEnd) return false;
  const lineStart = ta.value.lastIndexOf("\n", pos - 1) + 1;
  const line = ta.value.slice(lineStart, pos);
  const m = /^(\s*)([-*]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
  if (!m) return false;
  if (!m[4].trim()) {
    ta.value = ta.value.slice(0, lineStart) + ta.value.slice(pos);
    ta.setSelectionRange(lineStart, lineStart);
    return true;
  }
  let marker = m[2];
  if (/^\d+\.$/.test(marker)) marker = `${parseInt(marker, 10) + 1}.`;
  const insert = "\n" + m[1] + marker + " " + (m[3] ? "[ ] " : "");
  ta.value = ta.value.slice(0, pos) + insert + ta.value.slice(pos);
  ta.setSelectionRange(pos + insert.length, pos + insert.length);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function mdInline(escaped) {
  const codes = [];
  let t = escaped.replace(/`([^`]+)`/g, (m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, `<img src="$2" alt="$1">`);
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+|mailto:[^)\s]+)\)/g, `<a href="$2" target="_blank" rel="noopener">$1</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/(^|\W)\*([^*\n]+)\*/g, "$1<i>$2</i>");
  t = t.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  t = t.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

// Renders the Markdown subset the editor produces: headings, lists
// (nested, incl. checklists whose boxes carry their source line),
// quotes, code blocks, pipe tables, rules, paragraphs. Input is
// escaped first; only http(s)/mailto links become anchors.
function renderMarkdown(src) {
  const lines = (src ?? "").split("\n");
  const out = [];
  const escLine = (l) => esc(l);
  let i = 0;
  const listStack = [];
  const closeListsTo = (indent) => {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) { out.push(listStack.pop().type === "ol" ? "</ol>" : "</ul>"); }
  };
  const closeAllLists = () => { while (listStack.length) { const l = listStack.pop(); out.push(l.type === "ol" ? "</ol>" : "</ul>"); } };
  while (i < lines.length) {
    const raw = lines[i];
    const line = escLine(raw);
    if (/^\s*```/.test(raw)) {
      closeAllLists();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(escLine(lines[i])); i++; }
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) { closeAllLists(); out.push(`<h${h[1].length + 2}>${mdInline(escLine(h[2]))}</h${h[1].length + 2}>`); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { closeAllLists(); out.push("<hr>"); i++; continue; }
    if (/^\|.*\|$/.test(raw.trim()) && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1].trim()) && lines[i + 1].includes("-")) {
      closeAllLists();
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(raw);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { rows.push(cells(lines[i])); i++; }
      out.push(`<table><thead><tr>${head.map((c) => `<th>${mdInline(escLine(c))}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${mdInline(escLine(c))}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^>\s?/.test(raw)) {
      closeAllLists();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(mdInline(escLine(lines[i].replace(/^>\s?/, "")))); i++; }
      out.push(`<blockquote>${buf.join("<br>")}</blockquote>`);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (li) {
      const indent = li[1].length;
      const type = /^\d/.test(li[2]) ? "ol" : "ul";
      if (!listStack.length || indent > listStack[listStack.length - 1].indent) { listStack.push({ indent, type }); out.push(type === "ol" ? "<ol>" : "<ul>"); }
      else { closeListsTo(indent); if (!listStack.length || listStack[listStack.length - 1].indent !== indent) { listStack.push({ indent, type }); out.push(type === "ol" ? "<ol>" : "<ul>"); } }
      const check = /^\[([ xX])\]\s+(.*)$/.exec(li[3]);
      if (check) out.push(`<li class="md-check"><label><input type="checkbox" data-md-line="${i}" ${check[1].toLowerCase() === "x" ? "checked" : ""}> ${mdInline(escLine(check[2]))}</label></li>`);
      else out.push(`<li>${mdInline(escLine(li[3]))}</li>`);
      i++;
      continue;
    }
    if (!raw.trim()) { closeAllLists(); i++; continue; }
    closeAllLists();
    const buf = [mdInline(line)];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|>\s?|(\s*)([-*]|\d+\.)\s+)/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) { buf.push(mdInline(escLine(lines[i]))); i++; }
    out.push(`<p>${buf.join("<br>")}</p>`);
  }
  closeAllLists();
  return out.join("\n");
}

function bindMdEditors(root) {
  $$(".md-editor", root).forEach((ed) => {
    const ta = ed.querySelector("textarea");
    const preview = ed.querySelector(".md-preview");
    if (!ta || !preview) return;
    const renderPreview = () => { preview.innerHTML = renderMarkdown(ta.value); };
    const grow = () => { if (ta.offsetParent !== null) { ta.style.height = "auto"; ta.style.height = Math.min(Math.max(ta.scrollHeight + 2, 96), 520) + "px"; } };
    ed.querySelector(".md-toolbar")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-md]");
      if (!btn) return;
      e.preventDefault();
      if (btn.dataset.md === "preview") {
        const show = preview.hidden;
        preview.hidden = !show;
        ta.hidden = show;
        btn.classList.toggle("active", show);
        if (show) renderPreview();
        return;
      }
      mdApply(ta, btn.dataset.md);
      grow();
      if (!preview.hidden) renderPreview();
    });
    ta.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "b") { e.preventDefault(); mdApply(ta, "bold"); }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === "i") { e.preventDefault(); mdApply(ta, "italic"); }
      else if (mod && !e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); mdApply(ta, "link"); }
      else if (e.key === "Enter") { if (mdContinueList(ta)) { e.preventDefault(); grow(); } }
      else if (e.key === "Tab") { e.preventDefault(); const p = ta.selectionStart; ta.value = ta.value.slice(0, p) + "  " + ta.value.slice(ta.selectionEnd); ta.setSelectionRange(p + 2, p + 2); }
    });
    ta.addEventListener("input", grow);
    preview.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-md-line]");
      if (!cb) return;
      const idx = parseInt(cb.dataset.mdLine, 10);
      const ls = ta.value.split("\n");
      if (ls[idx]) { ls[idx] = ls[idx].replace(/\[[ xX]\]/, cb.checked ? "[x]" : "[ ]"); ta.value = ls.join("\n"); renderPreview(); }
    });
    grow();
  });
}

function bodyFieldHtml(table, id, body, version) {
  return `${mdEditorHtml(body, 5)}<span class="muted"> v${version}</span>`;
}
function subtaskBlock(table, id, subtasksJson) {
  let subs = [];
  try { subs = JSON.parse(subtasksJson ?? "[]"); } catch { subs = []; }
  // Checked-off subtasks list first (in the order they were checked —
  // the stored order of the done group), then the open ones in the
  // order they were added (Ben, Nov 5 2026).
  const ordered = [...subs.filter((s) => s.done), ...subs.filter((s) => !s.done)];
  return `<h4>Subtasks</h4>
    <div data-sub-list>
      ${ordered.map((s) => `<div class="row" data-sub-row="${s.id}" draggable="true"><span class="sub-grip" aria-hidden="true">⠿</span><input type="checkbox" ${s.done ? "checked" : ""}><span data-sub-text>${esc(s.text)}</span><button type="button" data-sub-del aria-label="Delete subtask">×</button></div>`).join("") || "<p class='muted'>No subtasks.</p>"}
    </div>
    <div class="inline-add"><input data-sub-new placeholder="New subtask"><button type="button" data-add-sub-btn>Add</button></div>`;
}

// Collect the subtask checklist from a merged save form's DOM.
function readSubtasks(form) {
  return [...form.querySelectorAll("[data-sub-row]")].map((row) => ({
    id: row.dataset.subRow,
    text: row.querySelector("[data-sub-text]").textContent,
    done: row.querySelector("input").checked ? 1 : 0,
  }));
}
function recurrenceForm(row) {
  const { rule } = parseRecurrence(row.recurrence ?? "");
  const freq = rule?.freq ?? "";
  const weekdays = rule?.weekdays ?? [1, 2, 3, 4, 5];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const selDays = dayNames.filter((_, i) => weekdays.includes(i));
  const weekdaySummary = !selDays.length ? "none" : selDays.length === 7 ? "every day" : selDays.join(" ");
  return `<h4>Repeats</h4>
    <div class="cf-box">
      <div class="cf-row">
        <div class="cf-field"><label class="cf-label">Frequency</label><select name="freq"><option value="">No repeat</option><option value="daily" ${freq === "daily" ? "selected" : ""}>Daily</option><option value="weekly" ${freq === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${freq === "monthly" ? "selected" : ""}>Monthly</option></select></div>
        <div class="cf-field"><label class="cf-label">Every</label><input type="number" name="interval" value="${rule?.interval ?? 1}" min="1"></div>
        <div class="cf-field"><label class="cf-label">Ends</label><input type="date" name="end" value="${rule?.endDate ?? ""}"></div>
      </div>
      <div data-rec-weekdays ${freq !== "weekly" ? "hidden" : ""}><button type="button" class="ghost-btn" data-rec-days-toggle aria-expanded="false">Weekdays: ${weekdaySummary} \u25b8</button>
      <div data-rec-days hidden>${dayNames.map((d, i) => `<label><input type="checkbox" name="wd" value="${i}" ${weekdays.includes(i) ? "checked" : ""}>${d}</label>`).join(" ")}</div></div>
    </div>
    ${rule ? `<p class="muted">${esc(recurrenceSummary(rule))}</p><p><button type="button" data-skip="${row.id}">Skip occurrence</button> <button type="button" data-stop="${row.id}">Stop recurring</button></p>` : ""}`;
}
function linksBlock(fromType, fromId) {
  const links = [...forwardLinks(fromType, fromId), ...backlinks(fromType, fromId)];
  const seen = new Set();
  const uniq = links.filter((l) => {
    const k = `${l.type}:${l.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // One searchable picker across every linkable type — no type select
  // first (Ben, Nov 4, 2026). Excludes the item itself and anything
  // already linked; the hidden value carries "type:id".
  const LINK_LABELS = { tasks: "Task", notes: "Note", people: "Person", reading_items: "Reading", projects: "Project" };
  const candidates = [];
  for (const t of Object.keys(LINK_LABELS)) {
    for (const r of allRows(t)) {
      if (t === fromType && r.id === fromId) continue;
      if (seen.has(`${t}:${r.id}`)) continue;
      candidates.push({ type: t, id: r.id, title: r.title ?? "" });
    }
  }
  candidates.sort((a, b) => a.title.localeCompare(b.title));
  return `<h4>Links</h4>
    ${uniq.map((l) => `<div class="row"><span class="badge">${esc(l.type)}</span><span class="row-title" data-open="${l.type}:${l.id}">${esc(l.row.title)}</span><button data-remove-link="${fromType}:${fromId}:${l.type}:${l.id}">Remove</button></div>`).join("") || "<p class='muted'>No links.</p>"}
    <form data-add-link="${fromType}:${fromId}" class="form inline inline-add">
      <div class="cf-combo" data-combo>
        <input type="text" data-combo-input placeholder="Search all items to link…" autocomplete="off">
        <input type="hidden" name="linkTarget" data-combo-value value="">
        <div class="cf-combo-list" data-combo-list hidden>
          ${candidates.map((c) => `<button type="button" data-combo-id="${c.type}:${c.id}" data-combo-title="${esc(`${c.title} (${LINK_LABELS[c.type]})`)}">${esc(c.title)} <span class="badge">${c.type}</span></button>`).join("")}
          <p data-combo-empty hidden style="padding:8px 12px" class="muted">No matches.</p>
        </div>
      </div>
      <button>Add link</button>
    </form>`;
}

function taskEditorHtml(id, forPage) {
  const t = state.store.getRow("tasks", id);
  if (!t) return;
  const parentId = state.store.getTaskParent(id);
  const parent = parentId ? state.store.getRow("tasks", parentId) : null;
  const children = linkedTitles("tasks", id, "sub_tasks", "tasks");
  const parentOptions = allRows("tasks").filter((x) => x.id !== id);
  const childIds = new Set(children.map((c) => c.id));
  const descendantIds = new Set();
  {
    const queue = [...childIds];
    while (queue.length) {
      const cur = queue.shift();
      if (descendantIds.has(cur)) continue;
      descendantIds.add(cur);
      for (const g of linkedTitles("tasks", cur, "sub_tasks", "tasks")) queue.push(g.id);
    }
  }
  const linkOptions = allRows("tasks").filter((x) => x.id !== id && !childIds.has(x.id) && !descendantIds.has(x.id));
  const fid = forPage ? "task-save-form-page" : "task-save-form";
  return `
    <form data-edit-task="${t.id}" id="${fid}" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(t.title)}" required></div>
      <div class="cf-row"><div class="cf-field"><label class="cf-label">Due</label><input type="date" name="due" value="${t.due_date ?? ""}"></div>
      <div class="cf-field"><label class="cf-label">Priority</label>${selectHtml("priority", vocabValues("tasks", "priority"), t.priority)}</div></div>
      <div class="cf-field"><label class="cf-label">Project</label><select name="project"><option value="">—</option>${vocabOptions("tasks", "project", t.project).map((v) => `<option value="${esc(v)}" ${v === t.project ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new__">New project…</option></select><div style="margin-top:8px"><input name="projectNew" placeholder="New project" hidden></div></div>
      <div class="cf-field"><label class="cf-label">Parent</label>
        <div class="cf-combo" data-combo>
          <input type="text" data-combo-input placeholder="Type to filter…" autocomplete="off" value="${parent ? esc(parent.title) : ""}">
          <input type="hidden" name="parentId" data-combo-value value="${parentId ?? ""}">
          <div class="cf-combo-list" data-combo-list hidden>
            <button type="button" data-combo-id="" data-combo-title="— No parent —">— No parent —</button>
            ${parentOptions.slice().sort((a, b) => a.title.localeCompare(b.title)).map((p) => `<button type="button" data-combo-id="${p.id}" data-combo-title="${esc(p.title)}">${esc(p.title)}</button>`).join("")}
            <p data-combo-empty hidden style="padding:8px 12px" class="muted">No matches.</p>
          </div>
        </div></div>
      ${parent ? `<p class="muted">Parent: <span class="row-title" data-open="tasks:${parent.id}">${esc(parent.title)}</span></p>` : ""}
      ${subtaskBlock("tasks", id, t.subtasks)}
    <h4>Linked subtasks</h4>
    ${children.map((c) => `<div class="row"><span class="row-title" data-open="tasks:${c.id}">${esc(c.row.title)}</span></div>`).join("") || "<p class='muted'>No linked subtasks yet.</p>"}
    ${linkOptions.length ? `<div data-link-subtask-wrap class="inline-add">
      <div class="cf-combo" data-combo>
        <input type="text" data-combo-input placeholder="Link an existing task…" autocomplete="off">
        <input type="hidden" data-combo-value value="">
        <div class="cf-combo-list" data-combo-list hidden>
          ${linkOptions.slice().sort((a, b) => a.title.localeCompare(b.title)).map((t) => `<button type="button" data-combo-id="${t.id}" data-combo-title="${esc(t.title)}">${esc(t.title)}</button>`).join("")}
          <p data-combo-empty hidden style="padding:8px 12px" class="muted">No matches.</p>
        </div>
      </div>
      <button type="button" data-link-subtask="${t.id}">Link</button>
    </div>` : ""}
      <h4>Body</h4>${bodyFieldHtml("tasks", id, t.body_markdown, t.body_version)}
      ${recurrenceForm(t)}
      <h4>Tags</h4>${tagsForm("tasks", id)}
    </form>
    ${linksBlock("tasks", id)}
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-send-tony="tasks:${t.id}" class="ghost-btn">Send to Tony</button><button data-duplicate-task="${t.id}" class="ghost-btn">Duplicate</button><button data-archive-task="${t.id}" class="danger-btn">Archive task</button></p>`}`;
}

function openTaskPopup(id) {
  const __row = state.store.getRow("tasks", id);
  if (__row) openPopup(__row.title, taskEditorHtml(id, false), `tasks:${id}`);
}

function noteEditorHtml(id, forPage) {
  const n = state.store.getRow("notes", id);
  if (!n) return;
  const fid = forPage ? "note-save-form-page" : "note-save-form";
  return `
    <form data-edit-note="${n.id}" id="${fid}" class="form popup-form">
      ${attachmentsHtml("notes", n.id)}
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(n.title)}" required></div>
      <div class="cf-field"><label class="cf-label">Type</label><select name="type"><option value="">—</option>${vocabOptions("notes", "type", n.type).map((v) => `<option value="${esc(v)}" ${v === n.type ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new__">New type…</option></select><div style="margin-top:8px"><input name="typeNew" placeholder="New type" hidden></div></div>
      <div class="cf-field"><label class="cf-label">Date</label><input type="date" name="date" value="${n.date ?? ""}"></div>
      <h4>Tags</h4>${tagsForm("notes", id)}
      <h4>Body</h4>${bodyFieldHtml("notes", id, n.body_markdown, n.body_version)}
    </form>
    ${linksBlock("notes", id)}
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-share-tony="notes:${n.id}" class="ghost-btn">Share with Tony</button><button data-duplicate-note="${n.id}" class="ghost-btn">Duplicate</button><button data-archive-note="${n.id}" class="danger-btn">Archive note</button></p>`}`;
}

function openNotePopup(id) {
  const __row = state.store.getRow("notes", id);
  if (__row) openPopup(__row.title, noteEditorHtml(id, false), `notes:${id}`);
}

function personEditorHtml(id, forPage) {
  const p = state.store.getRow("people", id);
  if (!p) return;
  const noteLinks = state.db.prepare("SELECT from_type, from_id FROM relations WHERE to_type='people' AND to_id=? AND relation_name='people'").all(id);
  const items = noteLinks.map((r) => ({ type: r.from_type, row: state.store.getRow(r.from_type, r.from_id) })).filter((x) => x.row);
  const fid = forPage ? "person-save-form-page" : "person-save-form";
  return `
    <form data-edit-person="${p.id}" id="${fid}" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" value="${esc(p.title)}" required></div>
      <div class="cf-field"><label class="cf-label">Role</label><select name="role"><option value="">—</option>${vocabOptions("people", "role", p.role).map((v) => `<option value="${esc(v)}" ${v === p.role ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new__">New role…</option></select><div style="margin-top:8px"><input name="roleNew" placeholder="New role" hidden></div></div>
      <h4>Body</h4>${bodyFieldHtml("people", id, p.body_markdown, p.body_version)}
    </form>
    ${items.length ? `<h4>Linked items</h4>${items.map((x) => `<div class="row"><span class="badge">${esc(x.type)}</span><span class="row-title" data-open="${x.type}:${x.row.id}">${esc(x.row.title)}</span></div>`).join("")}` : ""}
    ${linksBlock("people", id)}
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-archive-person="${p.id}" class="danger-btn">Archive person</button></p>`}`;
}

function openPersonPopup(id) {
  const __row = state.store.getRow("people", id);
  if (__row) openPopup(__row.title, personEditorHtml(id, false), `people:${id}`);
}

function projectEditorHtml(id, forPage) {
  const p = state.store.getRow("projects", id);
  if (!p) return;
  const related = new Set(state.store.listRelatedTodos(id));
  const tasks = allRows("tasks");
  const fid = forPage ? "project-save-form-page" : "project-save-form";
  return `
    <form data-edit-project="${p.id}" id="${fid}" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" value="${esc(p.title)}" required></div>
      <div class="cf-field"><label class="cf-label">Category</label><select name="category"><option value="">—</option>${vocabOptions("projects", "category", p.category).map((v) => `<option value="${esc(v)}" ${v === p.category ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new__">New category…</option></select><div style="margin-top:8px"><input name="categoryNew" placeholder="New category" hidden></div></div>
      <div class="cf-field"><label class="cf-label">Status</label>${selectHtml("status", vocabValues("projects", "status"), p.status)}</div>
      <h4>Body</h4>${bodyFieldHtml("projects", id, p.body_markdown, p.body_version)}
      ${subtaskBlock("projects", id, p.subtasks)}
      <h4>Related todos</h4>
      <div class="cf-combo" data-todo-picker>
        <input type="text" data-todo-filter placeholder="Type to filter tasks…" autocomplete="off">
        <div class="cf-combo-list" data-todo-list hidden></div>
      </div>
      <div data-todo-selected>${[...related].map((tid) => { const t = tasks.find((x) => x.id === tid); return t ? `<div class="row"><span class="row-title">${esc(t.title)}</span><input type="hidden" name="todo" value="${t.id}"><button type="button" data-todo-remove>✕</button></div>` : ""; }).join("")}</div>
    </form>
    ${linksBlock("projects", id)}
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-archive-project="${p.id}" class="danger-btn">Archive project</button></p>`}`;
}

function openProjectPopup(id) {
  const __row = state.store.getRow("projects", id);
  if (__row) openPopup(__row.title, projectEditorHtml(id, false), `projects:${id}`);
}

function readingEditorHtml(id, forPage) {
  const r = state.store.getRow("reading_items", id);
  if (!r) return;
  const fid = forPage ? "reading-save-form-page" : "reading-save-form";
  return `
    <form data-edit-reading="${r.id}" id="${fid}" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(r.title)}" required></div>
      <div class="cf-field"><label class="cf-label">URL</label><input name="url" value="${esc(r.url ?? "")}" required></div>
      <div class="cf-field"><label class="cf-label">Status</label>${selectHtml("status", vocabValues("reading_items", "status"), r.status, false)}</div>
      <p class="muted">Source: ${esc(r.source ?? "")} · added ${esc(r.added ?? "")}</p>
      <h4>Notes</h4>${bodyFieldHtml("reading_items", id, r.body_markdown, r.body_version)}
    </form>
    ${linksBlock("reading_items", id)}
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-send-tony="reading_items:${r.id}" class="ghost-btn">Send to Tony</button><button data-archive-reading="${r.id}" class="danger-btn">Archive item</button></p>`}`;
}

function openReadingPopup(id) {
  const __row = state.store.getRow("reading_items", id);
  if (__row) openPopup(__row.title, readingEditorHtml(id, false), `reading_items:${id}`);
}

function inboxEditorHtml(id, forPage) {
  const item = state.store.getRow("inbox_items", id);
  if (!item) return;
  const fid = forPage ? "inbox-save-form-page" : "inbox-save-form";
  return `
    <form data-edit-inbox="${id}" id="${fid}" class="form popup-form">
      ${attachmentsHtml("inbox_items", id)}
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(item.title)}"></div>
      <h4>Body</h4>${bodyFieldHtml("inbox_items", id, item.body_markdown, item.body_version)}
    </form>
    ${forPage ? `<p class="page-savebar"><button type="submit" form="${fid}" class="primary-btn">Save</button></p>` : `<p class="popup-actions"><button type="submit" form="${fid}" class="primary-btn">Close</button><button data-move-personal="${id}">Move to Personal Notes</button><button data-send-tony="inbox:${id}" class="ghost-btn">Send to Tony</button> <button data-archive-inbox="${id}" class="danger-btn">Archive</button> </p>`}`;
}

function openInboxPopup(id) {
  const __row = state.store.getRow("inbox_items", id);
  if (__row) openPopup(__row.title, inboxEditorHtml(id, false), `inbox_items:${id}`);
}

function openPopupByRef(type, id) {
  if (type === "tasks") openTaskPopup(id);
  else if (type === "notes") openNotePopup(id);
  else if (type === "people") openPersonPopup(id);
  else if (type === "projects") openProjectPopup(id);
  else if (type === "reading_items") openReadingPopup(id);
  else if (type === "inbox_items") openInboxPopup(id);
  else if (type === "custom_objects") { const row = state.store.getRow("custom_objects", id); if (row) openCustomPopup(row.type, id); }
}

// --- Full item pages (opened via the popup header's Open button) ---
function parsePageRef(ref) {
  const parts = ref.split(":");
  if (parts[0] === "custom") return { type: "custom", slug: parts[1], id: parts[2] };
  return { type: parts[0], id: parts[1] };
}
function viewRef(view) {
  return view.type === "custom" ? `custom:${view.slug}:${view.id}` : `${view.type}:${view.id}`;
}
function openPageRef(ref) {
  state.itemView = parsePageRef(ref);
  render();
}
function pageTags(table, id) {
  const tags = state.store.listTags(table, id);
  if (!tags.length) return "";
  return `<p>${tags.map((t) => `<span class="badge">${esc(t)}</span>`).join(" ")}</p>`;
}
function pageBody(body) {
  return body ? `<h4>Body</h4><div class="page-body">${esc(body)}</div>` : "";
}
function pageLinks(fromType, fromId) {
  const links = [...forwardLinks(fromType, fromId), ...backlinks(fromType, fromId)];
  const seen = new Set();
  const uniq = links.filter((l) => {
    const k = `${l.type}:${l.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const refFor = (l) => l.type === "custom_objects" ? `custom:${l.row.type}:${l.id}` : `${l.type}:${l.id}`;
  return `<h4>Links</h4>
    ${uniq.map((l) => `<div class="row"><span class="badge">${esc(l.type)}</span><span class="row-title" data-open-page="${refFor(l)}">${esc(l.row.title)}</span></div>`).join("") || "<p class='muted'>No links.</p>"}`;
}
function pageSubtasks(subtasksJson) {
  let subs = [];
  try { subs = JSON.parse(subtasksJson ?? "[]"); } catch { subs = []; }
  return `<h4>Subtasks</h4>
    ${subs.map((x) => `<div class="row"><input type="checkbox" disabled ${x.done ? "checked" : ""}><span>${esc(x.text)}</span></div>`).join("") || "<p class='muted'>No subtasks.</p>"}`;
}
function pageActions(view, extra) {
  return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button>${extra || ""}${view.type === "tasks" ? `<button data-send-tony="tasks:${view.id}" class="ghost-btn">Send to Tony</button><button data-duplicate-task="${view.id}" class="ghost-btn">Duplicate</button>` : view.type === "notes" ? `<button data-share-tony="notes:${view.id}" class="ghost-btn">Share with Tony</button><button data-duplicate-note="${view.id}" class="ghost-btn">Duplicate</button>` : view.type === "reading_items" ? `<button data-send-tony="reading_items:${view.id}" class="ghost-btn">Send to Tony</button>` : ""}<button data-pin-toggle="${viewRef(view)}" class="ghost-btn">${isPinned(viewRef(view)) ? "Unpin" : "Pin"}</button><button data-md-download="${viewRef(view)}" class="ghost-btn">Download .md</button><button data-page-archive="${viewRef(view)}" class="danger-btn">Archive</button></div>`;
}
function renderItemPage(view) {
  const { type, id, slug } = view;
  if (type === "tasks") {
    const t = state.store.getRow("tasks", id);
    if (!t) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    const parentId = state.store.getTaskParent(id);
    const parent = parentId ? state.store.getRow("tasks", parentId) : null;
    const children = linkedTitles("tasks", id, "sub_tasks", "tasks");
    const { rule } = parseRecurrence(t.recurrence ?? "");
    const meta = [t.due_date ? `Due ${esc(t.due_date)}` : "", t.priority ? `Priority ${esc(t.priority)}` : "", t.project ? `Project ${esc(t.project)}` : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <div class="notebook">${taskEditorHtml(id, true)}</div>`;
  }
  if (type === "notes") {
    const n = state.store.getRow("notes", id);
    if (!n) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    const meta = [n.type ? `Type ${esc(n.type)}` : "", n.date ? esc(n.date) : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <div class="notebook">${noteEditorHtml(id, true)}</div>`;
  }
  if (type === "people") {
    const p = state.store.getRow("people", id);
    if (!p) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    const noteLinks = state.db.prepare("SELECT from_type, from_id FROM relations WHERE to_type='people' AND to_id=? AND relation_name='people'").all(id);
    const items = noteLinks.map((r) => ({ type: r.from_type, row: state.store.getRow(r.from_type, r.from_id) })).filter((x) => x.row);
    return `${pageActions(view)}
      <div class="notebook">${personEditorHtml(id, true)}</div>`;
  }
  if (type === "projects") {
    const p = state.store.getRow("projects", id);
    if (!p) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    const related = state.store.listRelatedTodos(id);
    const meta = [p.category ? `Category ${esc(p.category)}` : "", p.status ? `Status ${esc(p.status)}` : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <div class="notebook">${projectEditorHtml(id, true)}</div>`;
  }
  if (type === "reading_items") {
    const r = state.store.getRow("reading_items", id);
    if (!r) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    return `${pageActions(view)}
      <div class="notebook">${readingEditorHtml(id, true)}</div>`;
  }
  if (type === "inbox_items") {
    const item = state.store.getRow("inbox_items", id);
    if (!item) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button><button data-page-move="${id}">Move to Personal Notes</button><button data-send-tony="inbox:${id}" class="ghost-btn">Send to Tony</button><button data-md-download="${viewRef(view)}" class="ghost-btn">Download .md</button><button data-page-archive="${viewRef(view)}" class="danger-btn">Archive</button></div>
      <div class="notebook">${inboxEditorHtml(id, true)}</div>`;
  }
  if (type === "custom") {
    const def = state.store.getRow("custom_object_types", slug);
    const row = state.store.getRow("custom_objects", id);
    if (!def || !row) return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">This item no longer exists.</p>`;
    const fields = JSON.parse(def.fields_json ?? "[]");
    const vals = JSON.parse(row.fields_json ?? "{}");
    const show = (f) => {
      const v = vals[f.name];
      if (v === undefined || v === null || v === "") return "—";
      if (f.kind === "Yes-No") return v ? "Yes" : "No";
      return esc(String(v));
    };
    return `${pageActions(view)}
      <div class="notebook">${customEditorHtml(slug, id, true)}</div>`;
  }
  return `<div class="page-actions"><button data-page-back class="ghost-btn">Back</button></div><p class="muted">Unknown item type.</p>`;
}


// --- Browser history for item pages + tabs (stamp 2026-11-04h) ---
// render() calls pushNav() after every paint; it only pushes when the
// nav key actually changed, so ticks/saves don't spam history. Back /
// forward fire popstate, which re-derives tab/itemView and re-renders.
let navGuard = false;
let navLastKey = null;
function navKey() { return state.itemView ? `item:${viewRef(state.itemView)}` : `tab:${state.tab}`; }
function navHash(key) { return `#/${key.replace(":", "/")}`; }
function pushNav() {
  if (navGuard || typeof history === "undefined") return;
  const key = navKey();
  if (key === navLastKey) return;
  navLastKey = key;
  try { history.pushState({ key }, "", navHash(key)); } catch {}
}
function initNav() {
  if (typeof history === "undefined" || typeof window === "undefined") return;
  try {
    const m = (location.hash || "").match(/^#\/(item|tab)\/(.+)$/);
    if (m) {
      if (m[1] === "item") state.itemView = parsePageRef(decodeURIComponent(m[2]));
      else if (allTabIds().includes(m[2])) { state.itemView = null; state.tab = m[2]; }
    }
    navLastKey = navKey();
    history.replaceState({ key: navLastKey }, "", navHash(navLastKey));
    window.addEventListener("popstate", (e) => {
      const key = e.state?.key;
      if (!key) return;
      navGuard = true;
      navLastKey = key;
      if (key.startsWith("item:")) state.itemView = parsePageRef(key.slice(5));
      else if (key.startsWith("tab:")) { state.itemView = null; state.tab = key.slice(4); }
      render();
      navGuard = false;
    });
  } catch {}
}

// --- Tab renders ---
// Stamp cw: the first-run connect screen. Its card reuses .token-card
// and the existing [data-token-save] handler, so Connect goes through
// exactly the same save path as Management.
function tokenScreenHtml() {
  return `<div class="token-screen"><div class="panel"><h3>Connect DashBen</h3>
  <p class="muted">Enter your sync token and the app pulls your tasks, notes, and everything else from pkm.ben-cloud.net.</p>
  ${state.lastError ? `<p class="muted">\u26a0 ${esc(state.lastError)}</p>` : ""}
  <div class="token-card"><label for="sync-token-input">Sync token</label>
  <input id="sync-token-input" type="text" style="-webkit-text-security: disc;" autocomplete="off" data-1p-ignore="true" data-lpignore="true" placeholder="SYNC_TOKEN">
  <p><button data-token-save class="primary-btn">Connect</button></p></div></div></div>`;
}

function render() {
  if (state.searchDirty) { rebuildSearchIndex(); state.searchDirty = false; }
  if (document.body?.classList.contains("boot-preview")) { document.body.classList.remove("boot-preview"); document.body.classList.add("boot-faded"); }
  writeWidgetSnapshotThrottled();
  $("#sync-status").textContent = statusLine();
  $("#net-badge").textContent = navigator.onLine ? "Online" : "Offline";
  renderSidebar();
  $$(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    if (b.dataset.tab === "daily") {
      const n = openTasks().filter((t) => t.due_date && t.due_date <= todayToronto()).length;
      let badge = b.querySelector(".tab-badge");
      if (n > 0) {
        if (!badge && typeof document.createElement === "function") { badge = document.createElement("span"); badge.className = "tab-badge"; b.appendChild(badge); }
        if (badge) badge.textContent = String(n);
      } else if (badge) badge.remove();
    }
  });
  const feedBtn = $("#feed-btn"); if (feedBtn) feedBtn.classList.toggle("on", state.tab === "feed");
  const main = $("#main");
  if (state.needsToken) { main.innerHTML = tokenScreenHtml(); return; }
  if (state.itemView) main.innerHTML = renderItemPage(state.itemView);
  else if (state.tab === "dashboard") main.innerHTML = renderDashboard();
  else if (state.tab === "tasks") main.innerHTML = renderTasks();
  else if (state.tab === "notes") main.innerHTML = renderNotes();
  else if (state.tab === "inbox") main.innerHTML = renderInbox();
  else if (state.tab === "people") main.innerHTML = renderPeople();
  else if (state.tab === "reading") main.innerHTML = renderReading();
  else if (state.tab === "feed") main.innerHTML = renderFeed();
  else if (state.tab === "projects") main.innerHTML = renderProjects();
  else if (state.tab === "search") main.innerHTML = renderSearch();
  else if (state.tab === "daily") main.innerHTML = renderDaily();
  else if (state.tab === "calendar") main.innerHTML = renderCalendar();
  else if (state.tab === "review") main.innerHTML = renderReview();
  else if (state.tab === "management") main.innerHTML = renderManagement();
  else if (state.tab.startsWith("custom:")) main.innerHTML = renderCustomTab(state.tab.slice(7));
  bindMainForms();
  bindExtraForms();
  if (state.itemView) { bindPopupForms($("#main")); bindExtraPopupForms($("#main")); }
  if (state.booted && !state.itemView && state.tab === "daily") cacheBootHtml(JSON.stringify({ tab: state.tab, html: main.innerHTML }));
  pushNav();
}

// --- Family calendar (stamp 2026-11-04ai) ---
// Read-only view of the family Google calendar, fetched from the
// Worker's /api/sync/calendar (which reads the calendar's secret
// iCal address server-side — the calendar itself stays private).
// Cached in localStorage so the dashboard paints instantly and works
// offline; refreshed on boot, after syncs, and on demand, with a
// 15-minute freshness guard so it never hammers the feed.
const FAM_CACHE_KEY = "pkm-family-cal-v1";
function famSeed() {
  if (state.family) return state.family;
  try {
    const c = JSON.parse(localStorage.getItem(FAM_CACHE_KEY) || "null");
    if (c && Array.isArray(c.events)) { state.family = { status: "ok", events: c.events, fetchedAt: c.fetchedAt ?? 0 }; return state.family; }
  } catch {}
  state.family = { status: "idle", events: [], fetchedAt: 0 };
  return state.family;
}
async function loadFamilyCalendar(force = false) {
  const fam = famSeed();
  const t = state.transport;
  if (!t || !t.base || !t.token) return;
  if (!force && fam.status === "ok" && Date.now() - fam.fetchedAt < 15 * 60 * 1000) return;
  if (fam.loading) return;
  fam.loading = true;
  try {
    const res = await fetch(`${t.base}/api/sync/calendar?days=7`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (res.status === 501) {
      state.family = { status: "unconfigured", events: [], fetchedAt: 0 };
    } else if (!res.ok) {
      throw new Error(`calendar -> ${res.status}`);
    } else {
      const data = await res.json();
      state.family = { status: "ok", events: data.events ?? [], fetchedAt: Date.now() };
      try { localStorage.setItem(FAM_CACHE_KEY, JSON.stringify({ fetchedAt: state.family.fetchedAt, events: state.family.events })); } catch {}
    }
  } catch {
    if ((fam.events ?? []).length) { fam.status = "stale"; state.family = fam; }
    else state.family = { status: "error", events: [], fetchedAt: 0 };
  }
  state.family.loading = false;
  if (state.tab === "dashboard" && !state.itemView) render();
}
// --- News feed (stamp dh) ---
// The river itself is assembled server-side (GET /api/sync/feed on
// the sync transport); this client keeps a 15-minute copy, renders
// category views over it, and edits the source list into the synced
// ui_prefs 'feed_sources' row (store.getFeedSources/setFeedSources).
function feedSeed() {
  if (!state.feed) state.feed = { status: "idle", items: [], sources: [], errors: [], fetchedAt: 0, category: "All", loading: false, seen: null, lastOpen: 0, prevOpen: null, muted: null };
  return state.feed;
}

// Stamp dp: feed read state. The seen set + last-visit stamp live in the
// synced ui_prefs row "feed_seen", so reading on one device dims the
// story everywhere.
function feedSeenSet() {
  const f = feedSeed();
  if (!f.seen) { const sv = state.store.getFeedSeen(); f.seen = new Set(sv.links); f.lastOpen = sv.open || 0; }
  return f.seen;
}
function persistFeedSeen() {
  const f = feedSeed();
  state.store.setFeedSeen({ links: [...(f.seen ?? [])].slice(-400), open: f.lastOpen ?? 0 });
  saveBytes();
}
function feedMutedList() {
  const f = feedSeed();
  if (!f.muted) f.muted = state.store.getFeedMuted();
  return f.muted;
}
function feedMutedHit(i, muted) {
  if (!muted?.length) return false;
  const title = (i.title ?? "").toLowerCase();
  const sum = (i.summary ?? "").toLowerCase();
  const src = (i.source ?? "").toLowerCase();
  return muted.some((m) => { const t = String(m).trim().toLowerCase(); return !!t && (title.includes(t) || sum.includes(t) || src === t); });
}
function updateFeedBadge() {
  // The unread pill is gone (Ben, Nov 6 2026) — the "from before your
  // last visit" divider carries that signal now. This just strips any
  // badge an older build left behind on the persistent tab buttons.
  document.querySelector('[data-tab="feed"]')?.querySelector(".tab-badge")?.remove();
  $("#feed-btn")?.querySelector(".feed-badge")?.remove();
}

function feedAgo(iso) {
  if (!iso) return "";
  const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function loadFeed(force = false) {
  const f = feedSeed();
  const t = state.transport;
  if (!t || !t.base || !t.token) return;
  if (!force && f.status === "ok" && Date.now() - f.fetchedAt < 15 * 60 * 1000) return;
  if (f.loading) return;
  f.loading = true;
  try {
    const res = await fetch(`${t.base}/api/sync/feed`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!res.ok) throw new Error(`feed -> ${res.status}`);
    const data = await res.json();
    state.feed = { ...f, status: "ok", items: data.items ?? [], sources: data.sources ?? [], errors: data.errors ?? [], fetchedAt: Date.now(), loading: false };
    updateFeedBadge();
  } catch {
    f.loading = false;
    f.status = f.items.length ? "stale" : "error";
  }
  if (state.tab === "feed" && !state.itemView) render();
}

function renderFeed() {
  const f = feedSeed();
  if (f.status === "idle") loadFeed();
  // Stamp dp: visiting stamps lastOpen; the divider + badge math use the
  // PREVIOUS visit's stamp, kept in prevOpen for the whole session.
  feedSeenSet();
  if (f.prevOpen === null || f.prevOpen === undefined) { f.prevOpen = f.lastOpen; f.lastOpen = Date.now(); persistFeedSeen(); updateFeedBadge(); }
  const cats = ["All", ...new Set(f.sources.map((x) => x.category))];
  if (!cats.includes(f.category)) f.category = "All";
  const muted = feedMutedList();
  const visible = f.items.filter((i) => !feedMutedHit(i, muted));
  const hiddenCount = f.items.length - visible.length;
  const items = f.category === "All" ? visible : visible.filter((i) => i.category === f.category);
  const savedUrls = new Set(allRows("reading_items").filter((r) => !r.archived && r.url).map((r) => r.url));
  let rowsHtml = "";
  let sawNew = false; let broke = false;
  for (const i of items) {
    const ix = f.items.indexOf(i);
    const isNew = f.prevOpen && i.published && Date.parse(i.published) > f.prevOpen;
    if (isNew) sawNew = true;
    if (!broke && sawNew && !isNew) { rowsHtml += `<div class="feed-divider"><span>Older — from before your last visit</span></div>`; broke = true; }
    const saved = savedUrls.has(i.link);
    rowsHtml += `<div class="feed-row${f.seen.has(i.link) ? " feed-read" : ""}"><div class="feed-meta"><span class="badge">${esc(i.source)}</span><span class="muted">${esc(i.category)}${i.published ? ` · ${feedAgo(i.published)}` : ""}</span><span class="feed-acts">${saved ? `<span class="feed-saved">Saved ✓</span>` : `<button data-feed-save="${ix}" class="ghost-btn feed-save">Save</button>`}</span></div><a class="feed-title" data-feed-open="${ix}" href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>${i.summary ? `<p class="feed-sum">${esc(i.summary)}</p>` : ""}</div>`;
  }
  return `<div class="feed-head"><div class="feed-chips">${cats.map((c) => `<button data-feed-cat="${esc(c)}" class="chip${c === f.category ? " chip-on" : ""}">${esc(c)}</button>`).join("")}</div><div class="feed-actions"><button data-feed-sources class="ghost-btn">Sources</button> <button data-feed-refresh class="ghost-btn">Refresh</button></div></div>
  ${f.status === "error" ? `<div class="panel"><p>Couldn't load the feed. <button data-feed-refresh class="ghost-btn">Retry</button></p></div>` : (f.status === "idle" || (f.loading && !f.items.length)) ? "<p class='muted'>Loading the river…</p>" : rowsHtml || "<p class='muted'>Nothing in this view yet.</p>"}
  ${f.errors?.length ? `<p class="muted">Couldn't fetch: ${f.errors.map((e) => esc(e.source)).join(", ")}</p>` : ""}
  ${f.fetchedAt ? `<p class="muted">Updated ${feedAgo(new Date(f.fetchedAt).toISOString())}${f.status === "stale" ? " · showing the last good copy" : ""}${hiddenCount ? ` · ${hiddenCount} hidden by mutes` : ""}</p>` : ""}`;
}

// The working source list for the editor: Ben's saved list when one
// exists, otherwise the effective list the endpoint last returned
// (the starter pack until he customizes).
function feedWorkingList() {
  return state.store.getFeedSources() ?? feedSeed().sources;
}

function saveFeedList(list) {
  state.store.setFeedSources(list);
  state.feedReload = true;
  openFeedSources();
  showToast("Sources saved");
}

function openFeedSources() {
  const custom = state.store.getFeedSources();
  const effective = feedWorkingList();
  const cats = [...new Set(effective.map((x) => x.category))];
  openPopup("Feed sources", `
  <p class="muted">${custom ? "Your custom source list \\u2014 it syncs to every client." : "You're on the built-in starter pack. Adding or removing a source saves it as your list."}</p>
  ${effective.map((x, ix) => `<div class="row"><span class="row-title">${esc(x.name)}</span><span class="muted">${esc(x.category)}</span><button data-feed-src-del="${ix}">Remove</button></div>`).join("") || "<p class='muted'>No sources.</p>"}
  <form data-feed-source-add class="form">
    <div class="cf-field"><label class="cf-label">Name</label><input name="name" required placeholder="e.g. CBC London"></div>
    <div class="cf-field"><label class="cf-label">Feed URL (RSS/Atom)</label><input name="url" required placeholder="https://\\u2026/feed"></div>
    <div class="cf-field"><label class="cf-label">Category</label><select name="category">${cats.map((c) => `<option>${esc(c)}</option>`).join("")}<option value="__new__">New category\\u2026</option></select></div>
    <div class="cf-field" data-feed-catnew hidden><label class="cf-label">New category</label><input name="categoryNew"></div>
    <p class="popup-actions"><button class="primary-btn">Add source</button></p>
  </form>
  ${custom ? `<p><button data-feed-src-reset class="ghost-btn">Reset to the starter pack</button></p>` : ""}
  <div class="feed-mute"><p><b>Muted words &amp; sources</b></p><p class="muted">One per line. A story hides when a muted word appears in its title or summary — or when the word exactly matches a source name, which mutes that whole source. Syncs to every client.</p><form data-feed-mute-form class="form"><textarea name="muted" rows="4" placeholder="one per line">${esc(feedMutedList().join("\n"))}</textarea><p class="popup-actions"><button class="primary-btn">Save mutes</button></p></form></div>`, "feed:sources");
}

function torontoYmdOf(iso) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return `${p.year}-${p.month}-${p.day}`;
}
function famEventDays(e) {
  if (e.allDay) {
    const out = [];
    let d = e.start;
    while (d < e.end && out.length < 14) { out.push(d); d = ymdAdd(d, 1); }
    return out.length ? out : [e.start];
  }
  const startDay = torontoYmdOf(e.start);
  const endMs = new Date(e.end).getTime();
  const endDay = endMs > new Date(e.start).getTime() ? torontoYmdOf(new Date(endMs - 1).toISOString()) : startDay;
  const out = [startDay];
  let d = startDay;
  while (d < endDay && out.length < 14) { d = ymdAdd(d, 1); out.push(d); }
  return out;
}
function famTimeLabel(e) {
  if (e.allDay) return "All day";
  const f = (iso) => new Date(iso).toLocaleTimeString("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit" });
  return `${f(e.start)} – ${f(e.end)}`;
}
function familyPanel() {
  const fam = famSeed();
  if (fam.status === "idle" || (fam.status === "error" && !(fam.events ?? []).length)) return "";
  if (fam.status === "unconfigured") {
    return `<div class="panel"><h3>Family calendar</h3><p class="muted">Not connected yet — add the FAMILY_CAL_ICS_URL secret to the pkm-new Worker (Google Calendar → Family calendar → Settings → “Secret address in iCal format”), deploy, then Refresh.</p><p><button type="button" data-fam-refresh class="ghost-btn">Refresh</button></p></div>`;
  }
  const today = todayToronto();
  const days = [];
  for (let i = 0; i < 7; i++) days.push(ymdAdd(today, i));
  const byDay = new Map(days.map((d) => [d, []]));
  for (const e of fam.events ?? []) for (const d of famEventDays(e)) if (byDay.has(d)) byDay.get(d).push(e);
  const label = (d, i) => i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long" });
  const sections = days.map((d, i) => {
    const list = byDay.get(d);
    if (!list.length) return "";
    return `<h4>${label(d, i)}</h4>` + list.map((e) => `<div class="row"><span class="fam-time">${esc(famTimeLabel(e))}</span><span class="row-title">${esc(e.title)}</span>${e.location ? `<span class="muted">${esc(e.location)}</span>` : ""}</div>`).join("");
  }).join("");
  const updated = fam.fetchedAt ? ` · updated ${new Date(fam.fetchedAt).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}` : "";
  return `<div class="panel"><h3>Family calendar <button type="button" data-fam-refresh class="ghost-btn fam-refresh">Refresh</button></h3>${fam.status === "stale" ? `<p class="muted">Couldn't refresh just now — showing the last copy${updated}.</p>` : ""}${sections || "<p class='muted'>Nothing on the family calendar this week.</p>"}</div>`;
}

// Phone dashboard weather (stamp au): one line instead of the full
// panel — today's icon, high/low, condition, current temperature.
// Phone weather (stamp bh): the one-line summary is the default
// look; tapping it expands in place with the day cards and the
// selected day's detail (3-hour chunks, stats) — the same data the
// full weather panel uses. state.weatherDay picks the day.
let wxOpen = false;
// More drawer (stamp bj): tapping anywhere outside the open drawer
// closes it, and that tap is swallowed so it doesn't also trigger
// whatever it landed on.
document.addEventListener("click", (e) => {
  const sb = document.querySelector("#sidebar");
  if (!sb?.classList.contains("open")) return;
  if (e.target.closest?.("#sidebar") || e.target.closest?.("#nav-more") || e.target.closest?.("#menu-btn")) return;
  sb.classList.remove("open");
  e.preventDefault();
  e.stopPropagation();
}, true);
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("[data-wx-toggle]")) return;
  wxOpen = !wxOpen;
  if (wxOpen && state.weatherDay == null) state.weatherDay = 0;
  render();
});
function weatherLineHtml() {
  if (!state.weather) {
    fetchWeather();
    return "";
  }
  const days = state.weather.daily;
  const { icon, condition } = weatherIcon(days.weathercode?.[0] ?? -1);
  const hi = Math.round(days.temperature_2m_max?.[0] ?? 0);
  const lo = Math.round(days.temperature_2m_min?.[0] ?? 0);
  const now = Math.round(state.weather.current.temperature_2m);
  const line = `<div class="panel wx-line" data-wx-toggle>${icon} <b>${hi}°</b><span class="muted"> / ${lo}° · ${esc(condition)} · ${now}° now · Mitchell</span>${state.weatherStale ? `<span class="muted"> · as of ${new Date(state.weatherStale).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}</span>` : ""}<span class="wx-chev">${wxOpen ? "▾" : "▸"}</span></div>`;
  if (!wxOpen) return line;
  const full = weatherPanel();
  const inner = full.replace(/^<div class="panel weather-panel"><h3>Weather — Mitchell, Ontario<\/h3>/, "").replace(/<\/div>$/, "");
  return `${line}<div class="panel wx-open">${inner}</div>`;
}

function renderDashboard() {
  const conflicts = state.engine.listConflicts();
  return `${weatherLineHtml()}
  ${pinnedPanel()}
  ${upcomingPanel()}
  ${familyPanel()}
  ${inboxPanel()}
  ${conflicts.length ? `<div class="panel"><h3>Sync conflicts (${conflicts.length}) — server row kept</h3>` + conflicts.map((c) => {
    let srv = null;
    try { srv = c.server_row_json ? JSON.parse(c.server_row_json) : null; } catch {}
    const title = srv?.title ? `: ${esc(srv.title)}` : "";
    return `<p class="conflict">${esc(c.table_name)} ${esc(c.row_id)}${title} <span class="muted">${esc(c.created_at ?? "")}</span> <button data-conflict-dismiss="${c.id}">Dismiss</button></p>`;
  }).join("") + `</div>` : ""}
  <div class="panel"><form data-dash-search class="form"><input name="q" placeholder="Search DashBen…" style="flex:1"><button>Search</button></form></div>
`;
}

const SUB_CHECKLIST_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 6.5l1.2 1.2L7 5.4"/><path d="M3.5 12.5l1.2 1.2L7 11.4"/><path d="M3.5 18.5l1.2 1.2L7 17.4"/><path d="M11 7h10"/><path d="M11 13h10"/><path d="M11 19h10"/></svg>`;
const SUB_LINK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

// --- Idea batch 2 helpers (stamps 2026-11-04w-ae) ---
// Tick grace period (stamp cx): checking a task off shows it done for
// a few seconds before the completion actually lands; tapping its
// checkbox again inside the window undoes it. Mirrors the widget's
// linger so the gesture means the same thing in both places.
const TICK_GRACE_MS = 4000;
const justDone = new Map();
function beginTickGrace(id) {
  if (justDone.has(id)) return;
  justDone.set(id, setTimeout(() => {
    justDone.delete(id);
    const r = state.store?.getRow("tasks", id);
    if (r && !r.done) { state.store.completeTask(id, todayToronto()); render(); saveBytes(); }
  }, TICK_GRACE_MS));
}
function cancelTickGrace(id) {
  if (!justDone.has(id)) return false;
  clearTimeout(justDone.get(id));
  justDone.delete(id);
  return true;
}

// Project picker for the quick-add forms (stamp cx): the task-project
// vocabulary, with General always present and selected by default.
function quickProjectSelect() {
  const vals = (() => { try { return vocabValues("tasks", "project"); } catch { return []; } })();
  const opts = [...new Set(["General", ...vals])];
  return `<select name="project" aria-label="Project">${opts.map((v) => `<option value="${esc(v)}"${v === "General" ? " selected" : ""}>${esc(v)}</option>`).join("")}</select>`;
}

// Smart quick-add (w): pull a due date and a priority out of a
// quick-task title. "Pay rent Fri P1" -> due Friday, P1, "Pay rent".
// Stamp cz: the rich parser also reports WHERE each match sits in the
// raw text (for inline highlighting) and honours a suppression set —
// a suppressed kind is neither highlighted nor applied, and its text
// stays in the title (Ben: cancel "this friday" and the task is added
// with that title, due today by the default rule).
function parseQuickTaskRich(raw, suppress = new Set()) {
  const src = String(raw ?? "");
  let priority = null, due = null;
  const marks = [];
  if (!suppress.has("priority")) {
    const pm = /\bP([1-3])\b/i.exec(src);
    if (pm) { priority = `P${pm[1]}`; marks.push({ start: pm.index, len: pm[0].length, kind: "priority" }); }
  }
  const today = todayToronto();
  const base = new Date(today + "T12:00:00");
  const fmt = (d) => d.toISOString().slice(0, 10);
  const addD = (n) => { const d = new Date(base); d.setDate(d.getDate() + n); return fmt(d); };
  function monthDay(monStr, dayStr) {
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
    const mo = months[monStr.toLowerCase()];
    let d = new Date(base.getFullYear(), mo, parseInt(dayStr, 10), 12);
    if (d < base) d = new Date(base.getFullYear() + 1, mo, parseInt(dayStr, 10), 12);
    return fmt(d);
  }
  const patterns = [
    [/\b(\d{4}-\d{2}-\d{2})\b/, (m) => m[1]],
    [/\btomorrow\b/i, () => addD(1)],
    [/\btoday\b/i, () => today],
    [/\bnext week\b/i, () => addD(7)],
    [/\b(mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b/i, (m) => {
      const want = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 0, sunday: 0 }[m[1].toLowerCase()];
      return addD((want - base.getDay() + 7) % 7);
    }],
    [/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i, (m) => monthDay(m[1], m[2])],
    [/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i, (m) => monthDay(m[2], m[1])],
  ];
  if (!suppress.has("due")) {
    for (const [re, fn] of patterns) {
      const m = re.exec(src);
      if (m) { due = fn(m); marks.push({ start: m.index, len: m[0].length, kind: "due" }); break; }
    }
  }
  let title = src;
  for (const mk of [...marks].sort((a, b) => b.start - a.start)) title = title.slice(0, mk.start) + " " + title.slice(mk.start + mk.len);
  title = title.replace(/\s+/g, " ").trim();
  return { title: title || src.trim(), due, priority, marks };
}

function parseQuickTask(raw) {
  const r = parseQuickTaskRich(raw);
  return { title: r.title, due: r.due, priority: r.priority };
}

function highlightParsed(text, marks) {
  if (!marks || !marks.length) return esc(text) + " ";
  let out = "", pos = 0;
  for (const mk of [...marks].sort((a, b) => a.start - b.start)) {
    if (mk.start < pos) continue;
    out += esc(text.slice(pos, mk.start)) + `<mark>${esc(text.slice(mk.start, mk.start + mk.len))}</mark>`;
    pos = mk.start + mk.len;
  }
  return out + esc(text.slice(pos)) + " ";
}

function dueChipLabel(ymd) {
  return new Date(ymd + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
}

// Wire a quick-add form's title field for live parse highlighting +
// cancel chips (stamp cz). The backdrop mirrors the input's text with
// the parsed spans marked; chips under the field carry the x buttons
// that suppress a parse for this entry.
function wireSmartInput(form) {
  if (!form || form._smartWired) return;
  const input = form.querySelector(".hl-input");
  const back = form.querySelector(".hl-back");
  const chips = form.querySelector(".parse-chips");
  if (!input || !back) return;
  form._smartWired = true;
  if (!form._suppress) form._suppress = new Set();
  const refresh = () => {
    const r = parseQuickTaskRich(input.value, form._suppress);
    back.innerHTML = highlightParsed(input.value, r.marks);
    back.style.transform = `translateX(${-input.scrollLeft}px)`;
    if (chips) {
      const bits = [];
      if (r.due) bits.push(`<span class="pchip">\u{1F4C5} ${esc(dueChipLabel(r.due))}<button type="button" data-chip-x="due" aria-label="Cancel scheduling">\u00d7</button></span>`);
      if (r.priority) bits.push(`<span class="pchip">\u2691 ${esc(r.priority)}<button type="button" data-chip-x="priority" aria-label="Cancel priority">\u00d7</button></span>`);
      chips.innerHTML = bits.join("");
      chips.style.display = bits.length ? "flex" : "none";
    }
  };
  input.addEventListener("input", refresh);
  input.addEventListener("scroll", () => { back.style.transform = `translateX(${-input.scrollLeft}px)`; });
  chips?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-chip-x]");
    if (!b) return;
    form._suppress.add(b.dataset.chipX);
    refresh();
    input.focus();
  });
  refresh();
}

// Completed items on demand (stamp dv): replaces the always-on day
// progress bar + done-today titles. The button reveals the day's
// completed tasks (by completion date); rows are live — unticking
// one puts it back.
function completedDayHtml(day, bare = false) {
  const done = allRows("tasks").filter((t) => t.done && !t.archived && (t.updated_at ?? "").slice(0, 10) === day);
  if (!done.length) return "";
  const openNow = state.showDoneDay === day;
  const rows = openNow ? done.map((t) => taskRow(t)).join("") : "";
  if (bare) return `<div class="done-box"><button data-show-done="${day}" class="ghost-btn">${openNow ? "Hide completed" : `Show completed (${done.length})`}</button>${openNow ? `<div class="done-list">${rows}</div>` : ""}</div>`;
  return `<div class="panel"><h3>Completed</h3><button data-show-done="${day}" class="ghost-btn">${openNow ? "Hide" : `Show (${done.length})`}</button>${rows}</div>`;
}

// Pins (aa): synced ui_prefs list of page refs, shown on the dashboard.
function getPins() { try { return JSON.parse(state.store.getRow("ui_prefs", "pins")?.value ?? "[]"); } catch { return []; } }
function setPins(refs) { const ts = new Date().toISOString(); state.engine.localWrite("ui_prefs", { key: "pins", value: JSON.stringify(refs), updated_at: ts }, { baseUpdatedAt: state.store.getRow("ui_prefs", "pins")?.updated_at ?? null }); }
function isPinned(ref) { return getPins().includes(ref); }
function togglePin(ref) { const pins = getPins(); const i = pins.indexOf(ref); if (i >= 0) pins.splice(i, 1); else pins.push(ref); setPins(pins); }

// --- Templates (stamp 2026-11-04am) ---
// Stored in ui_prefs 'templates' (synced); the defaults below are
// virtual until the list is first written (add/delete in Management).
const DEFAULT_TEMPLATES = [
  { id: "tpl-concern", kind: "note", name: "Resident concern", title: "", type: "General Notes", body: "## Contact\nName: \nPhone / email: \n\n## Issue\n\n\n## Follow-up\n- [ ] " },
  { id: "tpl-meeting", kind: "note", name: "Meeting notes", title: "", type: "General Notes", body: "## Attendees\n\n\n## Notes\n\n\n## Actions\n- [ ] " },
  { id: "tpl-followup", kind: "task", name: "Follow-up", title: "Follow up: ", project: "General", body: "## Context\n\n\n## Next step\n- [ ] " },
];
function getTemplates() {
  try { const raw = state.store.getRow("ui_prefs", "templates")?.value; if (raw) { const l = JSON.parse(raw); if (Array.isArray(l)) return l; } } catch {}
  return DEFAULT_TEMPLATES.slice();
}
function setTemplates(list) { const ts = new Date().toISOString(); state.engine.localWrite("ui_prefs", { key: "templates", value: JSON.stringify(list), updated_at: ts }, { baseUpdatedAt: state.store.getRow("ui_prefs", "templates")?.updated_at ?? null }); }
function templateOptionsHtml(kind) { return getTemplates().filter((t) => t.kind === kind).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join(""); }
function applyTemplateToForm(form, id) {
  const t = getTemplates().find((x) => x.id === id);
  if (!t) return;
  const title = form.querySelector("[name=title]");
  if (title && t.title) title.value = t.title;
  const body = form.querySelector("[name=body]");
  if (body) body.value = t.body ?? "";
  if (t.kind === "task") { const p = form.querySelector("[name=project]"); if (p && t.project) p.value = t.project; }
  if (t.kind === "note") { const ty = form.querySelector("[name=type]"); if (ty && t.type) ty.value = t.type; }
  title?.focus();
}

// --- Reading auto-title (stamp 2026-11-04am) ---
// The Worker fetches the page server-side (no CORS wall) and returns
// its <title>/og:title; fills the form's title only when it's empty.
async function fetchLinkTitle(url) {
  const t = state.transport;
  if (!t?.base || !t?.token) return null;
  try {
    const res = await fetch(`${t.base}/api/sync/link-title?url=${encodeURIComponent(url)}`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (!res.ok) return null;
    const d = await res.json();
    return d.title || null;
  } catch { return null; }
}
function bindLinkTitle(form) {
  const url = form.querySelector("[name=url]");
  const title = form.querySelector("[name=title]");
  if (!url || !title) return;
  url.addEventListener("change", async () => {
    const u = url.value.trim();
    if (!u || title.value.trim()) return;
    const got = await fetchLinkTitle(u);
    if (got && !title.value.trim()) title.value = got;
  });
}

// --- Daily-tab day context (stamp 2026-11-04am) ---
// One-day family-calendar fetch for the date being viewed (the
// dashboard panel only covers the coming week), cached 15 minutes,
// plus the day's weather when it's inside the forecast window.
async function loadDayEvents(ymd) {
  const cur = state.dayEvents;
  if (cur?.loading) return;
  if (cur && cur.ymd === ymd && Date.now() - cur.fetchedAt < 15 * 60 * 1000) return;
  const t = state.transport;
  if (!t || !t.base || !t.token) return;
  state.dayEvents = { ymd, status: "loading", events: cur?.ymd === ymd ? cur.events : [], fetchedAt: cur?.fetchedAt ?? 0, loading: true };
  try {
    const res = await fetch(`${t.base}/api/sync/calendar?from=${ymd}&days=1`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (res.status === 501) state.dayEvents = { ymd, status: "unconfigured", events: [], fetchedAt: Date.now() };
    else if (!res.ok) throw new Error(`calendar -> ${res.status}`);
    else { const data = await res.json(); state.dayEvents = { ymd, status: "ok", events: data.events ?? [], fetchedAt: Date.now() }; }
  } catch { state.dayEvents = { ymd, status: "error", events: [], fetchedAt: Date.now() }; }
  if (state.tab === "daily" && state.dailyDate === ymd) render();
}
function dayContextPanel(ymd) {
  loadDayEvents(ymd);
  if (!state.weather && !state.weatherTried) fetchWeather();
  const de = state.dayEvents;
  const evs = de && de.ymd === ymd && de.status === "ok" ? de.events : [];
  let wx = "";
  const daily = state.weather?.daily;
  if (daily?.time) {
    const i = daily.time.indexOf(ymd);
    if (i >= 0) { const w = weatherIcon(daily.weathercode?.[i] ?? -1); wx = `<p class="cal-ev"><span class="fam-time">${w.icon} ${Math.round(daily.temperature_2m_max[i])}° / ${Math.round(daily.temperature_2m_min[i])}°</span> ${esc(w.condition)}${daily.precipitation_sum?.[i] ? ` · ${daily.precipitation_sum[i]} mm precip` : ""}</p>`; }
  }
  if (!evs.length && !wx) return "";
  return `<div class="panel day-context"><h3>On this day</h3>${wx}${evs.map((e) => `<p class="cal-ev">${e.allDay ? `<span class="fam-time">All day</span>` : `<span class="fam-time">${esc(famTimeLabel(e))}</span>`} ${esc(e.title)}${e.location ? ` <span class="muted">@ ${esc(e.location)}</span>` : ""}</p>`).join("")}</div>`;
}

function pinnedPanel() {
  const pins = getPins();
  if (!pins.length) return "";
  const rows = [];
  for (const ref of pins) {
    const v = parsePageRef(ref);
    const table = v.type === "custom" ? "custom_objects" : v.type;
    const row = state.store.getRow(table, v.id);
    if (!row || row.archived) continue;
    rows.push(`<div class="row" data-pin-open="${ref}"><span class="pin-type">${esc(tabLabel(table))}</span><span class="row-title">${esc(row.title)}</span></div>`);
  }
  return rows.length ? `<div class="panel"><h3>Pinned</h3>${rows.join("")}</div>` : "";
}


// Reading queue (ad): oldest not-yet-read items, top of the pile.
function readingQueuePanel() {
  const doneWords = ["read", "finished", "done"];
  const queue = allRows("reading_items").filter((r) => !r.archived && !doneWords.includes((r.status ?? "").trim().toLowerCase())).sort((a, b) => (a.added ?? a.created_at ?? "").localeCompare(b.added ?? b.created_at ?? "")).slice(0, 3);
  if (!queue.length) return "";
  return `<div class="panel"><h3>Reading queue</h3>${queue.map((r) => `<div class="row" data-open="reading_items:${r.id}"><span class="row-title">${esc(r.title)}</span><button data-reading-done="${r.id}" class="ghost-btn">Read</button></div>`).join("")}</div>`;
}

// Duplicate (ab): copies body, subtasks (reset), links, attachments.
function duplicateTask(id) {
  const t = state.store.getRow("tasks", id);
  if (!t) return;
  const copy = state.store.createTask({ title: `${t.title} copy`, due: t.due_date ?? null, priority: t.priority ?? null, project: t.project ?? null, body: t.body_markdown ?? "" });
  if (t.place) state.store.updateProps("tasks", copy.id, { place: t.place });
  try { const subs = JSON.parse(t.subtasks ?? "[]"); if (subs.length) state.store.setSubtasks("tasks", copy.id, subs.map((s) => ({ ...s, done: 0 }))); } catch {}
  for (const l of forwardLinks("tasks", id)) { try { state.store.addLink("tasks", copy.id, l.type, l.id); } catch {} }
  closePopup(); state.itemView = null; render(); saveBytes(); openTaskPopup(copy.id);
}
function duplicateNote(id) {
  const n = state.store.getRow("notes", id);
  if (!n) return;
  const copy = state.store.createNote({ title: `${n.title} copy`, body: n.body_markdown ?? "", type: n.type ?? "General Notes" });
  if (copy && n.type && copy.type !== n.type) state.store.updateProps("notes", copy.id, { type: n.type });
  if (copy) state.store.copyAttachments("notes", id, "notes", copy.id);
  for (const l of forwardLinks("notes", id)) { try { state.store.addLink("notes", copy.id, l.type, l.id); } catch {} }
  closePopup(); state.itemView = null; render(); saveBytes(); openNotePopup(copy.id);
}

// Bulk select (ae): the Tasks view's action bar while selecting.
function bulkBarHtml() {
  const n = state.bulkSelected ? state.bulkSelected.size : 0;
  return `<div class="bulk-bar"><b>${n} selected</b><button data-bulk-action="complete" class="primary-btn">Complete</button><button data-bulk-action="postpone" class="ghost-btn">Postpone +1d</button><button data-bulk-action="archive" class="danger-btn">Archive</button><button data-bulk-action="clear" class="ghost-btn">Clear</button></div>`;
}

// --- Pill colours (stamp ei): every project, project status and
// person role gets a colour for its pill. Stored overrides live in
// the synced ui_prefs row "pill_colors" ({kind: {name: hex}}); names
// without an override fall back to a stable hash of the palette, so
// everything is coloured out of the box and edits sync everywhere.
function pillHashColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CLUSTER_COLORS[h % CLUSTER_COLORS.length];
}
function pillColors() {
  try { const v = JSON.parse(state.store.getRow("ui_prefs", "pill_colors")?.value ?? "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function pillColorFor(kind, name) {
  if (!name) return "";
  return pillColors()[kind]?.[name] || pillHashColor(name);
}
function setPillColor(kind, name, hex) {
  const map = pillColors();
  if (hex) { (map[kind] ??= {})[name] = hex; } else if (map[kind]) { delete map[kind][name]; }
  const ts = new Date().toISOString();
  state.engine.localWrite("ui_prefs", { key: "pill_colors", value: JSON.stringify(map), updated_at: ts }, { baseUpdatedAt: state.store.getRow("ui_prefs", "pill_colors")?.updated_at ?? null });
}
function pillStyle(kind, name) {
  const c = pillColorFor(kind, name);
  return ` style="color:${c};border-color:${c}99;background:${c}26"`;
}
function pillColorNames() {
  const un = (vals) => [...new Set(vals.filter(Boolean))];
  return {
    projects: un(allRows("projects").map((r) => r.title)).sort((a, b) => a.localeCompare(b)),
    statuses: un([...vocabValues("projects", "status"), ...allRows("projects").map((r) => r.status)]),
    roles: un([...vocabValues("people", "role"), ...allRows("people").map((r) => r.role)]),
  };
}
function pillColorsBody() {
  const groups = pillColorNames();
  const map = pillColors();
  const row = (kind, n) => { const c = pillColorFor(kind, n); return `<div class="mgmt-row"><span class="project-pill" style="color:${c};border-color:${c}99;background:${c}26">${esc(n)}</span><span class="pill-ctl"><input type="color" data-pill-color="${kind}|${esc(n)}" value="${c}"><button type="button" data-pill-reset="${kind}|${esc(n)}" class="ghost-btn"${map[kind]?.[n] ? "" : " disabled"}>Auto</button></span></div>`; };
  const part = (label, kind, names) => `<h4 class="mgmt-sub">${label}</h4>${names.length ? names.map((n) => row(kind, n)).join("") : "<p class='muted'>None yet.</p>"}`;
  return `<h4 class="mgmt-sub">Pill colours</h4><p class="muted">Every project, project status and person role gets its own pill colour. The starting colours are automatic — pick a swatch to override one, or Auto to go back. Colours sync across your devices.</p>${part("Projects", "projects", groups.projects)}${part("Project statuses", "statuses", groups.statuses)}${part("People roles", "roles", groups.roles)}`;
}
function clusterColor(name) {
  return pillColorFor("projects", name);
}
const CLUSTER_COLORS = ["#d98e4a", "#7ea6c9", "#a3b86b", "#c97b84", "#9b8ec4", "#6bb8a6", "#c9a86a", "#7fc4c9", "#b48ec9", "#8ec97f"];
// Dashboard and Daily task lists sort priority-first (Ben, Nov 6
// 2026): within each date group, P1..P4 then no priority. The sort is
// stable, so the underlying openTasks order (due date, then added)
// breaks ties.
function sortByPrio(list) {
  const rank = (p) => ({ P1: 1, P2: 2, P3: 3, P4: 4 })[p] ?? 5;
  return [...list].sort((a, b) => rank(a.priority) - rank(b.priority));
}
function taskRow(t, opts = {}) {
  const today = todayToronto();
  const overdue = !!t.due_date && t.due_date < today;
  let rec = false;
  try {
    const { rule } = parseRecurrence(t.recurrence ?? "");
    rec = !!rule;
  } catch { /* ignore */ }
  // Subtask indicators (stamp 2026-11-04o): one small icon per kind
  // present — checklist (done/total), linked (count) — rendered beside
  // the recurring indicator in the row's right-hand cluster.
  let subs = [];
  try { subs = JSON.parse(t.subtasks ?? "[]"); } catch { subs = []; }
  const subDone = subs.filter((s) => s.done).length;
  const linkedCount = linkedTitles("tasks", t.id, "sub_tasks", "tasks").length;
  const subInd = `${subs.length ? `<span class="sub-ind" title="Checklist subtasks: ${subDone} of ${subs.length} done">${SUB_CHECKLIST_ICON}${subDone}/${subs.length}</span>` : ""}${linkedCount ? `<span class="sub-ind" title="${linkedCount} linked subtask${linkedCount === 1 ? "" : "s"}">${SUB_LINK_ICON}${linkedCount}</span>` : ""}`;
  return `<div class="row${justDone.has(t.id) ? " row-justdone" : ""}" data-task="${t.id}">
    ${opts.bulk ? `<input type="checkbox" data-bulk-select="${t.id}" ${state.bulkSelected && state.bulkSelected.has(t.id) ? "checked" : ""}>` : `<input type="checkbox" data-tick="${t.id}" ${t.done || justDone.has(t.id) ? "checked" : ""}>`}
    <span class="row-title">${esc(t.title)}</span>
    ${subInd}${rec ? `<span class="recur" title="Recurring task">↻</span>` : ""}
    ${t.priority ? `<span class="prio">${esc(t.priority)}</span>` : ""}
    ${t.project ? `<span class="project-pill"${pillStyle("projects", t.project)}>${esc(t.project)}</span>` : ""}
    ${opts.carry ? `<button data-carry-today="${t.id}" class="ghost-btn">→ Today</button>` : ""}
    ${opts.snooze ? `<button data-snooze-days="1" data-snooze-task="${t.id}" class="pill-btn snooze-pill">+ 1d</button><button data-snooze-days="7" data-snooze-task="${t.id}" class="pill-btn snooze-pill">+ 1 wk</button><button data-snooze-mon data-snooze-task="${t.id}" class="pill-btn mon-pill">→ Mon</button>` : ""}
    <span class="due${overdue ? " overdue" : ""}">${t.due_date ? t.due_date : "No due date"}</span>
  </div>`;
}


// --- Group ordering (stamp 2026-11-04m) ---
// Grouped pages (Tasks by project, Notes by type, People by role,
// Reading by status, Projects by category) take their section order
// from Management > Group order, stored per grouping in ui_prefs
// (synced). Synthetic buckets keep their pins: the first/last lists
// win over the saved order; unsaved values fall back to the field's
// vocab order, then alphabetical.
function orderedGroupKeys(keys, prefKey, { first = [], last = [], fallback = [] } = {}) {
  const pref = state.store ? state.store.getGroupOrder(prefKey) : [];
  const rest = keys.filter((k) => !first.includes(k) && !last.includes(k));
  const inPref = pref.filter((v) => rest.includes(v));
  const remaining = rest.filter((v) => !inPref.includes(v)).sort((a, b) => {
    const ai = fallback.indexOf(a), bi = fallback.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
  return [...first.filter((k) => keys.includes(k)), ...inPref, ...remaining, ...last.filter((k) => keys.includes(k))];
}
const GROUPINGS = [
  { key: "tasks.project", label: "Tasks — by project", table: "tasks", field: "project" },
  { key: "notes.type", label: "Notes — by type", table: "notes", field: "type", exclude: ["Daily Notes"] },
  { key: "people.role", label: "People — by role", table: "people", field: "role" },
  { key: "projects.category", label: "Projects — by category", table: "projects", field: "category" },
  { key: "reading_items.status", label: "Reading — by status", table: "reading_items", field: "status" },
];
function groupOrderCandidates(g) {
  const vals = new Set(vocabValues(g.table, g.field));
  for (const r of allRows(g.table)) { const v = r[g.field]; if (v) vals.add(v); }
  for (const x of g.exclude ?? []) vals.delete(x);
  return orderedGroupKeys([...vals], g.key, { fallback: vocabValues(g.table, g.field) });
}

function renderTasks() {
  const filter = state.tasksFilter || "open";
  const prioRank = (p) => ({ P1: 1, P2: 2, P3: 3, P4: 4 })[p] ?? 5;
  const groupList = (list) => {
    const groups = new Map();
    for (const t of list) {
      const key = t.project || "No project";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const l of groups.values()) l.sort((a, b) => prioRank(a.priority) - prioRank(b.priority) || (a.due_date || "9999-12-31").localeCompare(b.due_date || "9999-12-31") || a.title.localeCompare(b.title));
    return orderedGroupKeys([...groups.keys()], "tasks.project", { last: ["No project"] }).map((k) => [k, groups.get(k)]);
  };
  const head = `<div class="tasks-head"><div class="toggle-group"><button data-tasks-filter="open" class="toggle-btn ${filter === "open" ? "active" : ""}">Open</button><button data-tasks-filter="done" class="toggle-btn ${filter === "done" ? "active" : ""}">Done</button></div><button data-bulk-toggle class="toggle-btn${state.bulkMode ? " active" : ""}">${state.bulkMode ? "Done selecting" : "Select"}</button><button data-new-task class="primary-btn">New task</button></div>`;
  if (filter === "done") {
    const done = doneTasks();
    return `${head}${done.map(taskRow).join("") || "<p class='muted'>Nothing done yet.</p>"}`;
  }
  const groupOrder = groupList(openTasks());
  return `${head}${state.bulkMode ? bulkBarHtml() : ""}${groupOrder.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((t) => taskRow(t, { bulk: !!state.bulkMode })).join("")}</details>`).join("") || "<p class='muted'>No open tasks.</p>"}`;
}

function openTaskCreatePopup() {
  const projects = vocabValues("tasks", "project");
  const parents = allRows("tasks").slice().sort((a, b) => a.title.localeCompare(b.title));
  openPopup("New task", `
    <form data-create-task-popup class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" required></div>
      <div class="cf-field"><label class="cf-label">Template</label><select data-template-pick><option value="">— Start blank —</option>${templateOptionsHtml("task")}</select></div>
      <div class="cf-row"><div class="cf-field"><label class="cf-label">Due date</label><input type="date" name="due"></div>
      <div class="cf-field"><label class="cf-label">Priority</label><select name="priority"><option value="">— No priority —</option>${vocabValues("tasks", "priority").map((p) => `<option>${p}</option>`).join("")}</select></div></div>
      <div class="cf-field"><label class="cf-label">Project</label>
        <select name="project"><option value="">— No project —</option>${projects.map((p) => `<option>${esc(p)}</option>`).join("")}<option value="__new__">New project…</option></select>
        <input name="projectNew" placeholder="New project name" hidden style="margin-top:8px"></div>
      <div class="cf-field"><label class="cf-label">Parent task</label>
        <div class="cf-combo" data-combo>
          <input type="text" data-combo-input placeholder="Type to filter…" autocomplete="off">
          <input type="hidden" name="parentId" data-combo-value value="">
          <div class="cf-combo-list" data-combo-list hidden>
            <button type="button" data-combo-id="" data-combo-title="— No parent —">— No parent —</button>
            ${parents.map((t) => `<button type="button" data-combo-id="${t.id}" data-combo-title="${esc(t.title)}">${esc(t.title)}</button>`).join("")}
            <p data-combo-empty hidden style="padding:8px 12px" class="muted">No matches.</p>
          </div>
        </div></div>
      <div class="cf-box"><p class="cf-label">Repeats</p>
        <div class="cf-row">
          <div class="cf-field"><label class="cf-label">Frequency</label><select name="freq"><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div>
          <div class="cf-field"><label class="cf-label">Every</label><input type="number" name="interval" value="1" min="1"></div>
          <div class="cf-field"><label class="cf-label">Ends</label><input type="date" name="end"></div>
        </div>
        <div data-weekdays hidden>Weekdays: ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<label><input type="checkbox" name="wd" value="${i}" ${i >= 1 && i <= 5 ? "checked" : ""}>${d}</label>`).join(" ")}</div>
      </div>
      <div class="cf-field"><label class="cf-label">Details</label>${mdEditorHtml("", 3, "Details (optional)")}</div>
      <button class="accent-btn">Create task</button>
    </form>`);
}
function renderNotes() {
  const isDaily = (n) => /^\d{4}-\d{2}-\d{2}$/.test(n.title ?? "") || n.type === "Daily Notes";
  const groups = new Map();
  for (const n of allNotes()) {
    const key = isDaily(n) ? "Daily notes" : (n.type || "No type");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const ordered = orderedGroupKeys([...groups.keys()], "notes.type", { first: ["Daily notes"], last: ["No type"] }).map((k) => [k, groups.get(k)]);
  const noteRow = (n) => `<div class="row" data-note="${n.id}"><span class="row-title">${esc(n.title)}</span><span class="muted">${esc(n.type ?? "")} ${n.date ?? ""}</span></div>`;
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-note class="primary-btn">New note</button></div>
  ${ordered.map(([g, list]) => `<details class="group" ${g === "Daily notes" ? "" : "open"}><summary>${esc(g)} (${list.length})</summary>${list.map(noteRow).join("")}</details>`).join("") || "<p class='muted'>No notes.</p>"}`;
}

function openNoteCreatePopup() {
  const allTags = state.db.prepare("SELECT DISTINCT tag FROM object_tags WHERE object_type='notes' ORDER BY tag").all().map((r) => r.tag);
  openPopup("New note", `
    <form data-create-note-popup class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" required></div>
      <div class="cf-field"><label class="cf-label">Template</label><select data-template-pick><option value="">— Start blank —</option>${templateOptionsHtml("note")}</select></div>
      <div class="cf-field"><label class="cf-label">Type</label>
        <select name="type">${vocabValues("notes", "type").map((t) => `<option ${t === "General Notes" ? "selected" : ""}>${t}</option>`).join("")}<option value="__new__">New type…</option></select>
        <input name="typeNew" placeholder="New type name" hidden style="margin-top:8px"></div>
      <div class="cf-field"><label class="cf-label">Tags</label>
        <div data-tag-input style="position:relative">
          <div class="cf-tag-box"><span data-tag-chips style="display:flex;flex-wrap:wrap;gap:6px"></span><input type="text" data-tag-text placeholder="Type to filter tags, or create a new one" autocomplete="off"></div>
          <input type="hidden" name="tags" data-tag-value value="">
          <div class="cf-tag-list" data-tag-list hidden>
            ${allTags.map((t) => `<button type="button" data-tag-option="${esc(t)}">${esc(t)}</button>`).join("")}
            <button type="button" data-tag-create hidden>Create “<span data-tag-create-name></span>”</button>
            <p data-tag-empty hidden style="padding:8px 12px" class="muted">No matching tags.</p>
          </div>
        </div></div>
      <div class="cf-field"><label class="cf-label">Date</label><input type="date" name="date"></div>
      <div class="cf-field"><label class="cf-label">Body</label>${mdEditorHtml("", 4, "Body (optional)")}</div>
      <button class="primary-btn">Create note</button>
    </form>`);
}
function openPersonCreatePopup() {
  openPopup("New person", `
    <form data-create-person-popup class="form">
      <input name="title" placeholder="Person name" required>
      <select name="role"><option value="">Role</option>${vocabValues("people", "role").map((r) => `<option>${r}</option>`).join("")}<option value="__new__">New role…</option></select>
      <input name="roleNew" placeholder="New role" hidden>
      <button>Add person</button>
    </form>`);
}

function openReadingCreatePopup() {
  openPopup("New reading item", `
    <form data-create-reading-popup class="form">
      <input name="title" placeholder="Title" required>
      <input name="url" placeholder="URL" required size="40">
      <select name="status">${vocabValues("reading_items", "status").map((st) => `<option>${st}</option>`).join("")}</select>
      <button>Add reading item</button>
    </form>`);
}

function openProjectCreatePopup() {
  openPopup("New project", `
    <form data-create-project-popup class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" required></div>
      <div class="cf-field"><label class="cf-label">Category</label>
        <select name="category"><option value="">— No category —</option>${vocabValues("projects", "category").map((c) => `<option>${esc(c)}</option>`).join("")}<option value="__new__">New category…</option></select>
        <input name="categoryNew" placeholder="New category name" hidden style="margin-top:8px"></div>
      <div class="cf-field"><label class="cf-label">Status</label>
        <select name="status"><option value="">— No status —</option>${vocabValues("projects", "status").map((st) => `<option>${st}</option>`).join("")}</select></div>
      <div class="cf-field"><label class="cf-label">Description</label>${mdEditorHtml("", 4, "Description (optional)")}</div>
      <button class="primary-btn">Create project</button>
    </form>`);
}
// --- Smart capture routing (stamp 2026-11-04ao) ---
// A bare URL files straight to Reading (title auto-fetched); a
// "task:" prefix makes a task (quick-add parsing applies); anything
// else stays an inbox capture. Returns what it did.
function routeCapture(text) {
  const t = (text || "").trim();
  if (!t) return "inbox";
  if (/^https?:\/\/\S+$/i.test(t)) {
    const item = state.store.createReading({ title: t, url: t });
    showToast("<span>Filed to Reading</span>");
    fetchLinkTitle(t).then((title) => {
      if (!title) return;
      const cur = state.store.getRow("reading_items", item.id);
      if (cur && cur.title === t) { state.store.updateProps("reading_items", item.id, { title }); render(); saveBytes(); }
    });
    return "reading";
  }
  const m = t.match(/^task:\s*(.+)$/is);
  if (m) {
    const p = parseQuickTask(m[1]);
    state.store.createTask({ title: p.title, due: p.due ?? todayToronto(), priority: p.priority, project: "General" });
    showToast("<span>Task created</span>");
    return "task";
  }
  return "inbox";
}

// --- Weekly review (stamp 2026-11-04ao) ---
function weekRange(offset) {
  const today = todayToronto();
  const dow = new Date(today + "T12:00:00").getDay();
  const monday = ymdAdd(today, -((dow + 6) % 7) + offset * 7);
  return { start: monday, end: ymdAdd(monday, 6) };
}
async function loadReviewCal(start) {
  const cur = state.reviewCal;
  if (cur?.loading) return;
  if (cur && cur.key === start && Date.now() - cur.fetchedAt < 15 * 60 * 1000) return;
  const t = state.transport;
  if (!t || !t.base || !t.token) return;
  state.reviewCal = { key: start, status: "loading", events: cur?.key === start ? cur.events : [], fetchedAt: cur?.fetchedAt ?? 0, loading: true };
  try {
    const res = await fetch(`${t.base}/api/sync/calendar?from=${start}&days=7`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (res.status === 501) state.reviewCal = { key: start, status: "unconfigured", events: [], fetchedAt: Date.now() };
    else if (!res.ok) throw new Error(`calendar -> ${res.status}`);
    else { const data = await res.json(); state.reviewCal = { key: start, status: "ok", events: data.events ?? [], fetchedAt: Date.now() }; }
  } catch { state.reviewCal = { key: start, status: "error", events: [], fetchedAt: Date.now() }; }
  if (state.tab === "review") render();
}
function renderReview() {
  const tw = weekRange(0);
  const nw = weekRange(1);
  const today = todayToronto();
  const inW = (iso, w) => { if (!iso) return false; const d = torontoYmdOf(iso); return d >= w.start && d <= w.end; };
  const doneThis = allRows("tasks").filter((t) => !t.archived && t.done && inW(t.updated_at, tw));
  const newTasks = allRows("tasks").filter((t) => !t.archived && inW(t.created_at, tw));
  const newNotes = allRows("notes").filter((t) => !t.archived && inW(t.created_at, tw));
  const dueNext = allRows("tasks").filter((t) => !t.archived && !t.done && t.due_date && t.due_date >= nw.start && t.due_date <= nw.end).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const overdue = allRows("tasks").filter((t) => !t.archived && !t.done && t.due_date && t.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
  loadReviewCal(nw.start);
  const rev = state.reviewCal;
  const revEvents = rev && rev.key === nw.start && rev.status === "ok" ? rev.events : [];
  const famDays = [];
  for (let i = 0; i < 7; i++) {
    const d = ymdAdd(nw.start, i);
    const evs = revEvents.filter((e) => famEventDays(e).includes(d));
    if (evs.length) famDays.push(`<h4>${esc(new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" }))}</h4>` + evs.map((e) => `<p class="cal-ev">${e.allDay ? `<span class="fam-time">All day</span>` : `<span class="fam-time">${esc(famTimeLabel(e))}</span>`} ${esc(e.title)}</p>`).join(""));
  }
  return `<div class="panel"><h3>Review</h3><p class="muted">This week ${esc(tw.start)} to ${esc(tw.end)} · next week ${esc(nw.start)} to ${esc(nw.end)}</p></div>
  <div class="panel"><h3>Completed this week (${doneThis.length})</h3>${doneThis.length ? doneThis.map((t) => taskRow(t)).join("") : "<p class='muted'>Nothing completed yet this week.</p>"}</div>
  <div class="panel"><h3>Overdue (${overdue.length})</h3>${overdue.length ? overdue.slice(0, 10).map((t) => taskRow(t, { carry: true, snooze: true })).join("") : "<p class='muted'>Nothing overdue.</p>"}</div>
  <div class="panel"><h3>Due next week (${dueNext.length})</h3>${dueNext.length ? dueNext.map((t) => taskRow(t)).join("") : "<p class='muted'>Nothing due next week.</p>"}</div>
  <div class="panel"><h3>Family next week</h3>${rev?.status === "unconfigured" ? "<p class='muted'>Family calendar isn't connected.</p>" : famDays.length ? famDays.join("") : "<p class='muted'>Nothing on the family calendar next week.</p>"}</div>
  <div class="panel"><h3>Created this week</h3><p class="muted">${newTasks.length} task(s) · ${newNotes.length} note(s)</p>${newNotes.slice(0, 8).map((n) => `<div class="row" data-open="notes:${n.id}"><span class="row-title">${esc(n.title)}</span></div>`).join("")}</div>`;
}

// --- Markdown export + download (stamp 2026-11-04ao) ---
function slugify(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled"; }
function mdLinks(type, id) {
  try {
    const rows = state.db.prepare(`SELECT from_type, from_id, to_type, to_id FROM relations WHERE (from_type=? AND from_id=?) OR (to_type=? AND to_id=?)`).all(type, id, type, id);
    const out = [];
    for (const r of rows) {
      const mine = r.from_type === type && r.from_id === id;
      const oType = mine ? r.to_type : r.from_type;
      const oId = mine ? r.to_id : r.from_id;
      const row = state.store.getRow(oType, oId);
      if (row && !row.archived) out.push(`- ${row.title} (${oType})`);
    }
    return out;
  } catch { return []; }
}
function objectToMarkdown(type, row) {
  const lines = [`# ${row.title || "Untitled"}`, ""];
  const meta = [];
  if (type === "tasks") { meta.push(`Status: ${row.done ? "Done" : "Open"}`); if (row.due_date) meta.push(`Due: ${row.due_date}`); if (row.priority) meta.push(`Priority: ${row.priority}`); if (row.project) meta.push(`Project: ${row.project}`); if (row.place) meta.push(`Place: ${row.place}`); }
  if (type === "notes") { if (row.type) meta.push(`Type: ${row.type}`); if (row.date) meta.push(`Date: ${row.date}`); }
  if (type === "people" && row.role) meta.push(`Role: ${row.role}`);
  if (type === "projects") { if (row.category) meta.push(`Category: ${row.category}`); if (row.status) meta.push(`Status: ${row.status}`); }
  if (type === "reading_items") { if (row.status) meta.push(`Status: ${row.status}`); if (row.url) meta.push(`URL: ${row.url}`); if (row.source) meta.push(`Source: ${row.source}`); }
  try { const tags = state.db.prepare(`SELECT tag FROM object_tags WHERE object_type=? AND object_id=? ORDER BY tag`).all(type, row.id).map((r) => r.tag); if (tags.length) meta.push(`Tags: ${tags.join(", ")}`); } catch {}
  if (meta.length) lines.push(...meta.map((m) => `- ${m}`), "");
  if (row.body_markdown) lines.push(row.body_markdown, "");
  if ((type === "tasks" || type === "projects") && row.subtasks) {
    try { const subs = JSON.parse(row.subtasks); if (Array.isArray(subs) && subs.length) lines.push("## Subtasks", "", ...subs.map((s) => `- [${s.done ? "x" : " "}] ${s.title}`), ""); } catch {}
  }
  const links = mdLinks(type, row.id);
  if (links.length) lines.push("## Links", "", ...links, "");
  const atts = state.store.attachmentsFor(type, row.id);
  if (atts.length) lines.push("## Attachments", "", ...atts.map((a) => `- ${a.name || a.mime}`), "");
  lines.push(`_Exported from DashBen · ${todayToronto()}_`);
  return lines.join("\n");
}
function crc32(bytes) {
  let table = crc32.table;
  if (!table) { table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } crc32.table = table; }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  const enc = new TextEncoder();
  const u16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
  const u32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255]);
  const cat = (...arrs) => { const total = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(total); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
  const chunks = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = cat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name);
    chunks.push(local, data);
    central.push(cat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    offset += local.length + data.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = cat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0));
  return cat(...chunks, ...central, end);
}
function downloadBytes(name, bytes, mime = "application/octet-stream") {
  if (typeof window !== "undefined" && window.__dashbenExportDb) { window.__dashbenExportDb(name, bytes); return; }
  const blob = new Blob([bytes], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportMarkdown() {
  const folders = { tasks: "tasks", notes: "notes", people: "people", projects: "projects", reading_items: "reading", inbox_items: "inbox" };
  const files = []; const used = new Set(); let count = 0;
  for (const [table, folder] of Object.entries(folders)) {
    for (const row of allRows(table)) {
      if (row.archived) continue;
      const base = `${folder}/${slugify(row.title)}`;
      let path = `${base}.md`; let n = 2;
      while (used.has(path)) path = `${base}-${n++}.md`;
      used.add(path);
      files.push({ name: path, data: objectToMarkdown(table, row) });
      count++;
    }
  }
  files.unshift({ name: "index.md", data: `# DashBen Markdown export\n\n${count} items · exported ${todayToronto()}.\n` });
  downloadBytes(`dashben-markdown-${todayToronto()}.zip`, zipStore(files), "application/zip");
  showToast(`<span>Markdown export saved (${count} items)</span>`);
}

function renderInbox() {
  const items = inboxItems();
  const photoCounts = attachmentCounts("inbox_items");
  const bulk = !!state.inboxBulk;
  const sel = state.inboxSel ?? new Set();
  return `<div class="panel"><h3>Capture</h3><form data-capture class="form"><input name="title" placeholder="Title (optional)"><textarea name="body" rows="3" placeholder="Capture… a pasted link files to Reading; start with task: to make a task"></textarea><input type="file" name="photo" accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.rtf" multiple><button class="primary-btn">Capture</button></form></div>
  ${bulk ? `<div class="panel bulk-bar"><strong>${sel.size} selected</strong> <button data-inbox-bulk-move class="primary-btn">Move to notes</button> <button data-inbox-bulk-archive class="danger-btn">Archive</button> <button data-inbox-bulk-clear class="ghost-btn">Clear</button></div>` : ""}
  <div class="panel"><div class="sel-head"><h3>Inbox (${items.length})</h3><button data-inbox-bulk-toggle class="toggle-btn${bulk ? " active" : ""}">${bulk ? "Done selecting" : "Select"}</button></div>
  ${items.map((i) => `<div class="row" data-inbox="${i.id}">${bulk ? `<input type="checkbox" data-inbox-sel="${i.id}"${sel.has(i.id) ? " checked" : ""}> ` : ""}<span class="row-title">${esc(i.title)}${photoInd(photoCounts, i.id)}</span><span class="muted">${esc((i.body_markdown ?? "").slice(0, 80))}</span><button data-archive-inbox="${i.id}">Archive</button></div>`).join("") || "<p class='muted'>Inbox empty.</p>"}</div>`;
}

function renderPeople() {
  const groups = new Map();
  for (const r of allRows("people")) {
    const key = r.role || "No role";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const ordered = orderedGroupKeys([...groups.keys()], "people.role", { last: ["No role"] }).map((k) => [k, groups.get(k)]);
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-person class="primary-btn">New person</button></div>
  ${ordered.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((r) => `<div class="row" data-person="${r.id}"><span class="row-title">${esc(r.title)}</span>${r.role ? `<span class="project-pill"${pillStyle("roles", r.role)}>${esc(r.role)}</span>` : ""}</div>`).join("")}</details>`).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
}

function renderReading() {
  const statusOrder = vocabValues("reading_items", "status");
  const groups = new Map();
  for (const r of allRows("reading_items")) {
    const key = r.status || "No status";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const ordered = orderedGroupKeys([...groups.keys()], "reading_items.status", { last: ["No status"], fallback: statusOrder }).map((k) => [k, groups.get(k)]);
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-reading class="primary-btn">New reading item</button></div>
  ${ordered.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((r) => `<div class="row"><span class="row-title" data-reading="${r.id}">${esc(r.title)}</span>${r.source ? `<span class="muted">${esc(r.source)}</span>` : ""}<select data-reading-status="${r.id}">${vocabValues("reading_items", "status").map((s) => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select></div>`).join("")}</details>`).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
}

function renderProjects() {
  const groups = new Map();
  for (const r of allRows("projects")) {
    const key = r.category || "No category";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const l of groups.values()) l.sort((a, b) => a.title.localeCompare(b.title)); // stamp du: A-Z inside groups (was updated_at order — the list reshuffled after every edit)
  const ordered = orderedGroupKeys([...groups.keys()], "projects.category", { last: ["No category"] }).map((k) => [k, groups.get(k)]);
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-project class="primary-btn">New project</button></div>
  ${ordered.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((r) => `<div class="row" data-project="${r.id}"><span class="row-title">${esc(r.title)}</span>${r.status ? `<span class="project-pill"${pillStyle("statuses", r.status)}>${esc(r.status)}</span>` : ""}${r.category ? `<span class="muted">${esc(r.category)}</span>` : ""}</div>`).join("")}</details>`).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
}

function renderSearch() {
  return `<form data-search class="form"><input name="q" placeholder="Search titles and bodies" id="search-input"><button>Search</button></form>
  <div id="search-results"><p class="muted">Search runs against the local database only — no network.</p></div>`;
}

function runSearch(q) {
  let html = null;
  try { html = runSearchTokens(q); } catch { html = null; }
  if (html !== null && html.length) {
    $("#search-results").innerHTML = html.join("");
    return;
  }
  const like = `%${q}%`;
  const out = [];
  for (const [table, label] of [["tasks", "Task"], ["notes", "Note"], ["people", "Person"], ["projects", "Project"], ["reading_items", "Reading"]]) {
    const rows = state.db.prepare(`SELECT id, title FROM ${table} WHERE archived=0 AND (title LIKE ? OR body_markdown LIKE ?) LIMIT 20`).all(like, like);
    for (const r of rows) out.push(`<div class="row"><span class="badge">${label}</span><span class="row-title" data-open="${table}:${r.id}">${esc(r.title)}</span></div>`);
  }
  $("#search-results").innerHTML = out.join("") || "<p class='muted'>No matches.</p>";
}




// --- Attachments (stamp 2026-11-04s): photos on inbox items and
// notes. Images are downscaled to <=1280px JPEG before storage, kept
// as base64 in the synced attachments table, and follow an inbox item
// when it is moved to notes.
const CAMERA_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
async function fileToAttachment(file) {
  const type = file?.type || "";
  if (type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      let dataUrl = canvas.toDataURL("image/jpeg", 0.82);
      if (dataUrl.length > 900000) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
      return { mime: "image/jpeg", data: dataUrl.split(",")[1], name: file.name || null };
    } finally { URL.revokeObjectURL(url); }
  }
  // Non-image files (stamp 2026-11-04ao): stored as-is under a cap.
  if (file.size > 512 * 1024) throw new Error("That file is over the 512 KB attachment limit.");
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  return { mime: type || "application/octet-stream", data: String(dataUrl).split(",")[1], name: file.name || null };
}
async function dataToAttachment(b64, mime) {
  const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
  return fileToAttachment(blob);
}
function attachmentsHtml(ownerType, ownerId) {
  const list = state.store.attachmentsFor(ownerType, ownerId);
  const images = list.filter((a) => (a.mime || "").startsWith("image/"));
  const files = list.filter((a) => !(a.mime || "").startsWith("image/"));
  return `<div class="attach-block">${images.length ? `<div class="attach-grid" data-photo-owner="${ownerType}:${ownerId}">${images.map((a) => `<span class="attach-thumb"><img src="data:${a.mime};base64,${a.data}" alt="Attached photo" data-photo-view="${a.id}"><button type="button" data-del-attachment="${a.id}" aria-label="Remove photo">\u00d7</button></span>`).join("")}</div>` : ""}${files.map((a) => `<p class="attach-file-row"><a class="attach-file" href="data:${a.mime};base64,${a.data}" download="${esc(a.name || "attachment")}">${esc(a.name || a.mime)}</a> <button type="button" data-del-attachment="${a.id}" class="ghost-btn" aria-label="Remove file">\u00d7</button></p>`).join("")}
    <label class="attach-add">${CAMERA_ICON} Add photo or file<input type="file" accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.rtf" multiple data-photo-add="${ownerType}:${ownerId}" hidden></label></div>`;
}
// Photo lightbox (stamp 2026-11-04aj): tap a thumbnail to view it
// full-screen; arrows, Esc and backdrop-click navigate/close.
let lbState = null;
function lightboxHtml(list, idx) {
  const a = list[idx];
  if (!a) return "";
  return `<div class="lightbox"><button type="button" class="lb-btn lb-close" data-lb-close aria-label="Close">\u00d7</button>${list.length > 1 ? `<button type="button" class="lb-btn lb-prev" data-lb-prev aria-label="Previous photo">\u2039</button><button type="button" class="lb-btn lb-next" data-lb-next aria-label="Next photo">\u203a</button>` : ""}<img src="data:${a.mime};base64,${a.data}" alt="Attached photo"><span class="lb-count">${idx + 1} / ${list.length}</span></div>`;
}
function renderLightbox() {
  let root = $("#lightbox-root");
  if (!root) {
    if (typeof document === "undefined" || !document.createElement) return;
    root = document.createElement("div");
    root.id = "lightbox-root";
    document.body.appendChild(root);
  }
  root.innerHTML = lbState ? lightboxHtml(lbState.list, lbState.idx) : "";
}
function showLightbox(ownerType, ownerId, attId) {
  const list = state.store.attachmentsFor(ownerType, ownerId);
  if (!list.length) return;
  lbState = { list, idx: Math.max(0, list.findIndex((a) => a.id === attId)) };
  renderLightbox();
}
function attachmentCounts(ownerType) {
  const map = new Map();
  try { for (const r of state.db.prepare("SELECT owner_id, COUNT(*) AS n FROM attachments WHERE owner_type=? AND archived=0 GROUP BY owner_id").all(ownerType)) map.set(r.owner_id, r.n); } catch {}
  return map;
}
function photoInd(counts, id) {
  const n = counts.get(id);
  return n ? `<span class="sub-ind" title="${n} photo${n === 1 ? "" : "s"} attached">${CAMERA_ICON}${n}</span>` : "";
}
function refreshOpenPopup() {
  const ref = document.querySelector("#popup-root [data-open-page]")?.dataset?.openPage;
  if (!ref) { closePopup(); return; }
  const v = parsePageRef(ref);
  if (v.type === "custom") openPopupByRef("custom_objects", v.id);
  else openPopupByRef(v.type, v.id);
}


// --- Send to Tony (stamp dw) -------------------------------------------
// Tasks, inbox items and reading items can be handed to Tony: a snapshot is appended
// to the synced ui_prefs queue "tony_outbox" (a poller on Tony's side
// drains it into the Sent to Tony chat), and the item is archived out
// of Ben's PKM with an Undo that also pulls the queue entry back.
// Notes are SHARED the same way but stay in the PKM.
function tonyOutbox() {
  try { const v = JSON.parse(state.store.getRow("ui_prefs", "tony_outbox")?.value ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeTonyOutbox(list) {
  const ts = new Date().toISOString();
  state.engine.localWrite("ui_prefs", { key: "tony_outbox", value: JSON.stringify(list), updated_at: ts }, { baseUpdatedAt: state.store.getRow("ui_prefs", "tony_outbox")?.updated_at ?? null });
}
function queueForTony(kind, row) {
  const entry = { qid: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), kind, title: row.title ?? "", body: row.body_markdown ?? "", queued_at: new Date().toISOString(), meta: {} };
  if (kind === "task") entry.meta = { due: row.due_date ?? "", priority: row.priority ?? "", project: row.project ?? "", subtasks: row.subtasks ?? "" };
  if (kind === "note") entry.meta = { date: row.date ?? "", type: row.type ?? "" };
  if (kind === "reading") entry.meta = { url: row.url ?? "", source: row.source ?? "", status: row.status ?? "" };
  const list = tonyOutbox(); list.push(entry); writeTonyOutbox(list);
  return entry;
}
function unqueueForTony(qid) { writeTonyOutbox(tonyOutbox().filter((e) => e.qid !== qid)); }
function doSendTony(ref) {
  const v = parsePageRef(ref);
  const table = v.type === "inbox" ? "inbox_items" : v.type;
  const row = state.store.getRow(table, v.id);
  if (!row) return;
  const entry = queueForTony(v.type === "inbox" ? "inbox" : v.type === "reading_items" ? "reading" : "task", row);
  state.store.archiveObject(table, v.id);
  state.searchDirty = true;
  toastUndo = () => { unqueueForTony(entry.qid); try { state.store.unarchiveObject(table, v.id); } catch {} state.searchDirty = true; const root = document.querySelector("#toast-root"); if (root) root.innerHTML = ""; render(); saveBytes(); };
  showToast(`<span>Sent \u201c${esc(row.title)}\u201d to Tony</span><button data-toast-undo class="primary-btn">Undo</button>`);
  if (state.itemView && state.itemView.id === v.id) state.itemView = null;
  closePopup(); render(); saveBytes();
}
function doShareTony(ref) {
  const v = parsePageRef(ref);
  const row = state.store.getRow("notes", v.id);
  if (!row) return;
  queueForTony("note", row);
  showToast(`<span>Shared \u201c${esc(row.title)}\u201d with Tony</span>`);
  saveBytes();
}

// --- Toasts, archive undo, database export (stamp 2026-11-04j) ---
let toastTimer = null;
let toastUndo = null;
function showToast(html) {
  const root = document.querySelector("#toast-root");
  if (!root) return;
  root.innerHTML = `<div class="toast">${html}</div>`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.innerHTML = ""; toastUndo = null; }, 9000);
}
function archiveWithUndo(table, id) {
  const title = state.store.getRow(table, id)?.title ?? "Item";
  state.store.archiveObject(table, id);
  toastUndo = () => {
    try { state.store.unarchiveObject(table, id); } catch {}
    state.searchDirty = true;
    const root = document.querySelector("#toast-root");
    if (root) root.innerHTML = "";
    render(); saveBytes();
  };
  showToast(`<span>Archived \u201c${esc(title)}\u201d</span><button data-toast-undo class="primary-btn">Undo</button>`);
}
async function exportDb() {
  try {
    const bytes = state.db.exportBytes();
    const name = `dashben-backup-${todayToronto()}.db`;
    if (typeof window !== "undefined" && window.__dashbenExportDb) {
      await window.__dashbenExportDb(name, bytes);
      showToast(`<span>Backup saved as ${esc(name)}</span>`);
      return;
    }
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast(`<span>Backup downloaded: ${esc(name)}</span>`);
  } catch (err) { alert(`Export failed: ${err.message}`); }
}

// --- Command palette (stamp 2026-11-04i): Ctrl/Cmd-K overlay ---
// Jump to any tab or item, or run a create/sync action, mouse-free.
// Items come from the same search_tokens index as the Search tab;
// picking one opens its full page.
let paletteState = null;
function paletteActions(q) {
  const acts = [];
  const lq = q.trim().toLowerCase();
  const match = (label) => !lq || label.toLowerCase().includes(lq);
  for (const id of allTabIds()) {
    const label = `Go to ${tabLabel(id)}`;
    if (match(label)) acts.push({ kind: "tab", label, run: () => { state.itemView = null; state.tab = id; saveTab(); render(); } });
  }
  const creates = [
    ["New task", () => openTaskCreatePopup()],
    ["New note", () => openNoteCreatePopup()],
    ["New reading item", () => openReadingCreatePopup()],
    ["New project", () => openProjectCreatePopup()],
    ["Capture to inbox", () => { state.itemView = null; state.tab = "inbox"; saveTab(); render(); document.querySelector("[data-capture] textarea")?.focus(); }],
    ["Sync now", () => doSync()],
  ];
  if (!dailyNoteFor(todayToronto())) creates.push(["Create today's daily note", () => { state.store.createNote({ title: todayToronto(), date: todayToronto() }); render(); saveBytes(); }]);
  for (const [label, run] of creates) if (match(label)) acts.push({ kind: "action", label, run });
  return acts;
}
function paletteItems(q) {
  const terms = tokenize(q);
  if (!terms.length || !state.db) return [];
  let rows = [];
  try {
    const parts = terms.map(() => "SELECT object_type, object_id, title FROM search_tokens WHERE token LIKE ?");
    rows = state.db.prepare(parts.join(" INTERSECT ")).all(...terms.map((t) => `${t}%`));
  } catch { rows = []; }
  const TYPE_LABEL = { tasks: "Task", notes: "Note", people: "Person", projects: "Project", reading_items: "Reading", inbox_items: "Inbox", custom_objects: "Item" };
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.object_type}:${r.object_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "item", label: r.title, typeLabel: TYPE_LABEL[r.object_type] ?? r.object_type, run: () => {
      if (r.object_type === "custom_objects") { const row = state.store.getRow("custom_objects", r.object_id); if (row) openPageRef(`custom:${row.type}:${row.id}`); }
      else openPageRef(`${r.object_type}:${r.object_id}`);
    } });
    if (out.length >= 10) break;
  }
  return out;
}
function paletteEntries() { const q = paletteState?.q ?? ""; return [...paletteActions(q), ...paletteItems(q)]; }
function openPalette() {
  if (!state.store) return;
  paletteState = { q: "", active: 0, entries: [] };
  const root = document.querySelector("#palette-root");
  if (!root) return;
  root.innerHTML = `<div class="palette-backdrop" data-palette-backdrop><div class="palette-card"><input id="palette-input" placeholder="Jump to or create…" autocomplete="off"><div class="palette-list" id="palette-list"></div><div class="palette-hint muted">↑↓ navigate · Enter select · Esc close</div></div></div>`;
  const input = document.querySelector("#palette-input");
  input.addEventListener("input", () => { paletteState.q = input.value; paletteState.active = 0; updatePaletteList(); });
  updatePaletteList();
  input.focus();
}
function closePalette() { paletteState = null; const root = document.querySelector("#palette-root"); if (root) root.innerHTML = ""; }
function updatePaletteList() {
  const list = document.querySelector("#palette-list");
  if (!list || !paletteState) return;
  const entries = paletteEntries();
  paletteState.entries = entries;
  if (paletteState.active >= entries.length) paletteState.active = Math.max(0, entries.length - 1);
  list.innerHTML = entries.map((e, i) => `<div class="palette-item${i === paletteState.active ? " active" : ""}" data-palette-idx="${i}"><span class="badge">${e.kind === "item" ? esc(e.typeLabel) : e.kind === "tab" ? "Go" : "Do"}</span><span class="palette-label">${esc(e.label)}</span></div>`).join("") || `<p class="muted" style="padding:10px 14px">No matches.</p>`;
  list.querySelector(".palette-item.active")?.scrollIntoView?.({ block: "nearest" });
}
function runPaletteEntry(i) { const ent = paletteState?.entries?.[i]; if (!ent) return; closePalette(); ent.run(); }

// --- Event binding ---
// Main-tab forms are rebound after every render (fresh DOM, so no
// duplicates). The #main click/change listeners are attached ONCE
// at boot — the old code re-attached a once-flagged listener per
// render, which meant clicking blank space silently killed row
// clicks until the next render.
function bindMainForms() {
  $$("[data-create-task]").forEach((f) => {
    const freq = $("[name=freq]", f);
    freq.addEventListener("change", () => { $("[data-weekdays]", f).hidden = freq.value !== "weekly"; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      let recurrence = null;
      if (d.get("freq")) {
        recurrence = { freq: d.get("freq"), interval: Number(d.get("interval") || 1), weekdays: d.getAll("wd").map(Number), endDate: d.get("end") || null, dayOfMonth: null };
      }
      state.store.createTask({ title: d.get("title"), due: d.get("due") || null, priority: d.get("priority") || null, project: d.get("project") || null, recurrence });
      render(); saveBytes();
    });
  });
  $$("[data-create-note]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    state.store.createNote({ title: d.get("title"), date: d.get("date") || null });
    render(); saveBytes();
  }));
  $$("[data-capture]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const bodyText = (d.get("body") || "").trim();
    const photos = d.getAll("photo").filter((p) => p && typeof p === "object" && "size" in p && p.size > 0);
    if (!bodyText && !photos.length) return;
    if (!photos.length && !(d.get("title") || "").trim() && routeCapture(bodyText) !== "inbox") { render(); saveBytes(); return; }
    const item = state.store.captureInbox({ title: d.get("title") || "", body: bodyText || "Photo" });
    for (const photo of photos) {
      try { const att = await fileToAttachment(photo); state.store.addAttachment("inbox_items", item.id, att.mime, att.data, att.name ?? null); }
      catch { alert("An attachment could not be added."); }
    }
    render(); saveBytes();
  }));
  $$("[data-create-simple]").forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const table = f.dataset.createSimple;
    if (table === "people") state.store.createPerson({ title: d.get("title"), role: d.get("role") || null });
    else if (table === "reading_items") state.store.createReading({ title: d.get("title"), url: d.get("url"), note: "" });
    else if (table === "projects") state.store.createProject({ title: d.get("title"), status: d.get("status") || null });
    render(); saveBytes();
  }));
  $$("[data-search]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    runSearch(new FormData(f).get("q") || "");
  }));
  $$("[data-dash-search]").forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = new FormData(f).get("q") || "";
    state.tab = "search";
    saveTab();
    render();
    const input = $("#search-input");
    if (input) input.value = q;
    runSearch(q);
  }));
}

async function saveBody(table, id, body) {
  const row = state.store.getRow(table, id);
  state.store.saveBody(table, id, body, row.body_version);
}

// Persist the subtask checklist from a popup edit form immediately, so
// closing the popup without Save never loses a tick, an add, or a delete.
// The merged Save re-reads the same DOM list, so it stays consistent.
function persistSubtasks(form) {
  const table = form.dataset.editTask ? "tasks" : "projects";
  const id = form.dataset.editTask || form.dataset.editProject;
  if (!id) return;
  state.store.setSubtasks(table, id, readSubtasks(form));
  saveBytes();
}

// Moving an inbox item to notes asks which category (note type) it gets.
// The explicit choice wins over the date-title -> Daily Notes rule.
function openMoveCategoryPrompt(item, from) {
  const title = item.title || (item.body_markdown ?? "").split("\n")[0].slice(0, 60);
  const defType = /^\d{4}-\d{2}-\d{2}$/.test(title.trim()) ? "Daily Notes" : "General Notes";
  const opts = vocabOptions("notes", "type", defType);
  openPopup("Move to notes", `<p class="muted">“${esc(title)}” will become a note. Pick its category:</p>
    <form data-move-category class="form">
      <input type="hidden" name="inboxId" value="${item.id}">
      <input type="hidden" name="from" value="${from}">
      <label class="cf-label">Category</label>
      <select name="category">${opts.map((v) => `<option value="${esc(v)}" ${v === defType ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>
      <input name="categoryNew" placeholder="Or type a new category…">
      <p class="popup-actions"><button type="submit" class="primary-btn">Move to notes</button><button type="button" data-close-popup class="ghost-btn">Cancel</button></p>
    </form>`);
}

function bindPopupForms(root = $("#popup-root")) {
  $$("[data-feed-src-del]", root).forEach((b) => b.addEventListener("click", () => {
    const list = [...feedWorkingList()];
    list.splice(Number(b.dataset.feedSrcDel), 1);
    saveFeedList(list);
  }));
  $$("[data-feed-src-reset]", root).forEach((b) => b.addEventListener("click", () => {
    state.store.setFeedSources(null);
    state.feedReload = true;
    openFeedSources();
    showToast("Back to the starter pack");
  }));
  $$("[data-feed-mute-form]", root).forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const lines = String(new FormData(f).get("muted") ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
    state.store.setFeedMuted(lines);
    feedSeed().muted = lines;
    showToast("Mute list saved");
    saveBytes();
    openFeedSources();
    render();
  }));
  $$("[data-feed-source-add]", root).forEach((f) => {
    const sel = f.querySelector("[name=category]");
    const nw = f.querySelector("[data-feed-catnew]");
    if (sel && nw) sel.addEventListener("change", () => { nw.hidden = sel.value !== "__new__"; });
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      const d = new FormData(f);
      const name = (d.get("name") || "").trim();
      const url = (d.get("url") || "").trim();
      if (!name || !/^https?:\/\//.test(url)) return;
      const category = d.get("category") === "__new__" ? ((d.get("categoryNew") || "").trim() || "General") : (d.get("category") || "General");
      saveFeedList([...feedWorkingList(), { name, url, category }]);
    });
  });
  bindMdEditors(root);
  // Subtask ticks and deletes persist immediately (delegated once: the
  // popup root element survives popup re-renders, its content does not).
  if (!root.dataset.subDelegated) {
    root.dataset.subDelegated = "1";
    let subDragSuppressUntil = 0;
    root.addEventListener("click", (e) => {
      if (Date.now() < subDragSuppressUntil && e.target.closest?.("[data-sub-row]")) return;
      const del = e.target.closest("[data-sub-del]");
      if (!del) return;
      const form = del.closest("form");
      const row = del.closest("[data-sub-row]");
      const list = form?.querySelector("[data-sub-list]");
      row?.remove();
      if (list && !list.querySelector("[data-sub-row]")) list.innerHTML = "<p class='muted'>No subtasks.</p>";
      if (form) persistSubtasks(form);
    });
    // Enter in the New-subtask box adds the subtask (stamp as): a
    // delegated capture-phase handler with a keyCode fallback, because
    // the per-input binding misses keys some Android IMEs deliver
    // without a clean key value (focus just jumped to the next field).
    root.addEventListener("keydown", (e) => {
      const inp = e.target.closest?.("[data-sub-new]");
      if (!inp) return;
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      inp.closest(".inline-add")?.querySelector("[data-add-sub-btn]")?.click();
    }, true);
    root.addEventListener("change", (e) => {
      const row = e.target.closest("[data-sub-row]");
      if (!row || e.target.type !== "checkbox") return;
      if (Date.now() < subDragSuppressUntil) return;
      // Checked-off subtasks rise to the top, in check order: a tick
      // moves the row to the end of the done block; an untick sends it
      // to the bottom of the open ones (Ben, Nov 5 2026).
      const list = row.parentElement;
      if (list) {
        if (e.target.checked) {
          const doneRows = [...list.querySelectorAll("[data-sub-row]")].filter((r) => r !== row && r.querySelector("input")?.checked);
          if (doneRows.length) doneRows[doneRows.length - 1].after(row); else list.prepend(row);
        } else list.append(row);
      }
      const form = row.closest("form");
      if (form) persistSubtasks(form);
    });
    // Drag to rearrange: reordering the DOM rows is enough — the drop
    // persists through the same readSubtasks order the save uses.
    let dragRow = null;
    root.addEventListener("dragstart", (e) => {
      const r = e.target.closest?.("[data-sub-row]");
      if (!r) return;
      dragRow = r;
      r.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", "subtask"); } catch {} }
    });
    root.addEventListener("dragover", (e) => {
      if (!dragRow) return;
      const r = e.target.closest?.("[data-sub-row]");
      if (!r || r === dragRow || r.parentElement !== dragRow.parentElement) return;
      e.preventDefault();
      const rect = r.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      r.parentElement.insertBefore(dragRow, after ? r.nextSibling : r);
    });
    root.addEventListener("dragend", () => {
      if (!dragRow) return;
      const form = dragRow.closest("form");
      dragRow.classList.remove("dragging");
      dragRow = null;
      subDragSuppressUntil = Date.now() + 250;
      if (form) persistSubtasks(form);
    });
    root.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.("[data-sub-row]")) e.preventDefault();
    });
    // Touch long-press drag: HTML5 drag events never fire for touch in
    // the Android WebView, so subtask rows also reorder via pointer
    // events. Hold still ~350 ms to arm the drag; moving sooner is a
    // scroll (rows have touch-action: none, so pre-arm vertical moves
    // scroll the popup manually) or a tap. Release persists via the
    // same persistSubtasks path, and the trailing click/change is
    // suppressed so a drag starting on the checkbox doesn't toggle it.
    let lpDrag = null;
    let lpTimer = null;
    const clearLpTimer = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      const row = e.target.closest?.("[data-sub-row]");
      if (!row || e.target.closest?.("[data-sub-del]")) return;
      clearLpTimer();
      lpDrag = { row, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY, active: false, moved: false, scrolling: false, sc: null };
      lpTimer = setTimeout(() => {
        if (!lpDrag || lpDrag.pointerId !== e.pointerId || lpDrag.scrolling) return;
        lpDrag.active = true;
        row.classList.add("dragging");
        try { row.setPointerCapture(e.pointerId); } catch {}
      }, 350);
    });
    root.addEventListener("pointermove", (e) => {
      if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
      if (!lpDrag.active) {
        if (lpDrag.scrolling) {
          if (lpDrag.sc) lpDrag.sc.scrollTop -= e.clientY - lpDrag.lastY;
          lpDrag.lastY = e.clientY;
          return;
        }
        const dx = e.clientX - lpDrag.startX, dy = e.clientY - lpDrag.startY;
        if (Math.hypot(dx, dy) > 10) {
          clearLpTimer();
          if (Math.abs(dy) > Math.abs(dx)) {
            lpDrag.scrolling = true;
            let sc = lpDrag.row.parentElement;
            while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            lpDrag.sc = sc || document.scrollingElement;
            if (lpDrag.sc) lpDrag.sc.scrollTop -= e.clientY - lpDrag.lastY;
            lpDrag.lastY = e.clientY;
          } else {
            lpDrag = null;
          }
        }
        return;
      }
      e.preventDefault();
      const list = lpDrag.row.parentElement;
      if (!list) return;
      const siblings = [...list.querySelectorAll("[data-sub-row]")].filter((r) => r !== lpDrag.row);
      const before = siblings.find((sib) => { const r = sib.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (before) {
        if (lpDrag.row.nextSibling !== before) { list.insertBefore(lpDrag.row, before); lpDrag.moved = true; }
      } else if (list.lastElementChild !== lpDrag.row) {
        list.appendChild(lpDrag.row);
        lpDrag.moved = true;
      }
    });
    const finishLp = (e) => {
      if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
      clearLpTimer();
      const wasActive = lpDrag.active, wasMoved = lpDrag.moved, wasScrolling = lpDrag.scrolling;
      const row = lpDrag.row;
      lpDrag = null;
      if (wasScrolling) { subDragSuppressUntil = Date.now() + 150; return; }
      if (!wasActive) return;
      row.classList.remove("dragging");
      subDragSuppressUntil = Date.now() + 300;
      if (wasMoved) { const form = row.closest("form"); if (form) persistSubtasks(form); }
    };
    root.addEventListener("pointerup", finishLp);
    root.addEventListener("pointercancel", finishLp);
  }
  // Subtask Add appends a row and persists it right away.
  $$("[data-add-sub-btn]", root).forEach((btn) => btn.addEventListener("click", () => {
    const form = btn.closest("form");
    const input = form.querySelector("[data-sub-new]");
    const list = form.querySelector("[data-sub-list]");
    const text = input.value.trim();
    if (!text || !list) return;
    list.querySelector("p.muted")?.remove();
    list.insertAdjacentHTML("beforeend", `<div class="row" data-sub-row="s-${Date.now()}" draggable="true"><span class="sub-grip" aria-hidden="true">⠿</span><input type="checkbox"><span data-sub-text>${esc(text)}</span><button type="button" data-sub-del aria-label="Delete subtask">×</button></div>`);
    input.value = "";
    input.focus();
    persistSubtasks(form);
  }));

  bindMdEditors(root);
  // Subtask ticks and deletes persist immediately (delegated once: the
  // popup root element survives popup re-renders, its content does not).
  if (!root.dataset.recDaysBound) {
    root.dataset.recDaysBound = "1";
    root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rec-days-toggle]");
      if (!btn) return;
      const box = btn.parentElement?.querySelector("[data-rec-days]");
      if (!box) return;
      box.hidden = !box.hidden;
      btn.setAttribute("aria-expanded", String(!box.hidden));
      btn.textContent = btn.textContent.replace(box.hidden ? "\u25be" : "\u25b8", box.hidden ? "\u25b8" : "\u25be");
    });
  }
  if (!root.dataset.subDelegated) {
    root.dataset.subDelegated = "1";
    let subDragSuppressUntil = 0;
    root.addEventListener("click", (e) => {
      if (Date.now() < subDragSuppressUntil && e.target.closest?.("[data-sub-row]")) return;
      const del = e.target.closest("[data-sub-del]");
      if (!del) return;
      const form = del.closest("form");
      const row = del.closest("[data-sub-row]");
      const list = form?.querySelector("[data-sub-list]");
      row?.remove();
      if (list && !list.querySelector("[data-sub-row]")) list.innerHTML = "<p class='muted'>No subtasks.</p>";
      if (form) persistSubtasks(form);
    });
    // Enter in the New-subtask box adds the subtask (stamp as): a
    // delegated capture-phase handler with a keyCode fallback, because
    // the per-input binding misses keys some Android IMEs deliver
    // without a clean key value (focus just jumped to the next field).
    root.addEventListener("keydown", (e) => {
      const inp = e.target.closest?.("[data-sub-new]");
      if (!inp) return;
      if (e.key !== "Enter" && e.keyCode !== 13) return;
      e.preventDefault();
      inp.closest(".inline-add")?.querySelector("[data-add-sub-btn]")?.click();
    }, true);
    root.addEventListener("change", (e) => {
      const row = e.target.closest("[data-sub-row]");
      if (!row || e.target.type !== "checkbox") return;
      if (Date.now() < subDragSuppressUntil) return;
      // Checked-off subtasks rise to the top, in check order: a tick
      // moves the row to the end of the done block; an untick sends it
      // to the bottom of the open ones (Ben, Nov 5 2026).
      const list = row.parentElement;
      if (list) {
        if (e.target.checked) {
          const doneRows = [...list.querySelectorAll("[data-sub-row]")].filter((r) => r !== row && r.querySelector("input")?.checked);
          if (doneRows.length) doneRows[doneRows.length - 1].after(row); else list.prepend(row);
        } else list.append(row);
      }
      const form = row.closest("form");
      if (form) persistSubtasks(form);
    });
    // Drag to rearrange: reordering the DOM rows is enough — the drop
    // persists through the same readSubtasks order the save uses.
    let dragRow = null;
    root.addEventListener("dragstart", (e) => {
      const r = e.target.closest?.("[data-sub-row]");
      if (!r) return;
      dragRow = r;
      r.classList.add("dragging");
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", "subtask"); } catch {} }
    });
    root.addEventListener("dragover", (e) => {
      if (!dragRow) return;
      const r = e.target.closest?.("[data-sub-row]");
      if (!r || r === dragRow || r.parentElement !== dragRow.parentElement) return;
      e.preventDefault();
      const rect = r.getBoundingClientRect();
      const after = e.clientY - rect.top > rect.height / 2;
      r.parentElement.insertBefore(dragRow, after ? r.nextSibling : r);
    });
    root.addEventListener("dragend", () => {
      if (!dragRow) return;
      const form = dragRow.closest("form");
      dragRow.classList.remove("dragging");
      dragRow = null;
      subDragSuppressUntil = Date.now() + 250;
      if (form) persistSubtasks(form);
    });
    root.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.("[data-sub-row]")) e.preventDefault();
    });
    // Touch long-press drag: HTML5 drag events never fire for touch in
    // the Android WebView, so subtask rows also reorder via pointer
    // events. Hold still ~350 ms to arm the drag; moving sooner is a
    // scroll (rows have touch-action: none, so pre-arm vertical moves
    // scroll the popup manually) or a tap. Release persists via the
    // same persistSubtasks path, and the trailing click/change is
    // suppressed so a drag starting on the checkbox doesn't toggle it.
    let lpDrag = null;
    let lpTimer = null;
    const clearLpTimer = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch") return;
      const row = e.target.closest?.("[data-sub-row]");
      if (!row || e.target.closest?.("[data-sub-del]")) return;
      clearLpTimer();
      lpDrag = { row, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY, active: false, moved: false, scrolling: false, sc: null };
      lpTimer = setTimeout(() => {
        if (!lpDrag || lpDrag.pointerId !== e.pointerId || lpDrag.scrolling) return;
        lpDrag.active = true;
        row.classList.add("dragging");
        try { row.setPointerCapture(e.pointerId); } catch {}
      }, 350);
    });
    root.addEventListener("pointermove", (e) => {
      if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
      if (!lpDrag.active) {
        if (lpDrag.scrolling) {
          if (lpDrag.sc) lpDrag.sc.scrollTop -= e.clientY - lpDrag.lastY;
          lpDrag.lastY = e.clientY;
          return;
        }
        const dx = e.clientX - lpDrag.startX, dy = e.clientY - lpDrag.startY;
        if (Math.hypot(dx, dy) > 10) {
          clearLpTimer();
          if (Math.abs(dy) > Math.abs(dx)) {
            lpDrag.scrolling = true;
            let sc = lpDrag.row.parentElement;
            while (sc && !(sc.scrollHeight > sc.clientHeight && /(auto|scroll)/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
            lpDrag.sc = sc || document.scrollingElement;
            if (lpDrag.sc) lpDrag.sc.scrollTop -= e.clientY - lpDrag.lastY;
            lpDrag.lastY = e.clientY;
          } else {
            lpDrag = null;
          }
        }
        return;
      }
      e.preventDefault();
      const list = lpDrag.row.parentElement;
      if (!list) return;
      const siblings = [...list.querySelectorAll("[data-sub-row]")].filter((r) => r !== lpDrag.row);
      const before = siblings.find((sib) => { const r = sib.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (before) {
        if (lpDrag.row.nextSibling !== before) { list.insertBefore(lpDrag.row, before); lpDrag.moved = true; }
      } else if (list.lastElementChild !== lpDrag.row) {
        list.appendChild(lpDrag.row);
        lpDrag.moved = true;
      }
    });
    const finishLp = (e) => {
      if (!lpDrag || e.pointerId !== lpDrag.pointerId) return;
      clearLpTimer();
      const wasActive = lpDrag.active, wasMoved = lpDrag.moved, wasScrolling = lpDrag.scrolling;
      const row = lpDrag.row;
      lpDrag = null;
      if (wasScrolling) { subDragSuppressUntil = Date.now() + 150; return; }
      if (!wasActive) return;
      row.classList.remove("dragging");
      subDragSuppressUntil = Date.now() + 300;
      if (wasMoved) { const form = row.closest("form"); if (form) persistSubtasks(form); }
    };
    root.addEventListener("pointerup", finishLp);
    root.addEventListener("pointercancel", finishLp);
  }
  // Subtask Add appends a row and persists it right away.
  $$("[data-add-sub-btn]", root).forEach((btn) => btn.addEventListener("click", () => {
    const form = btn.closest("form");
    const input = form.querySelector("[data-sub-new]");
    const list = form.querySelector("[data-sub-list]");
    const text = input.value.trim();
    if (!text || !list) return;
    list.querySelector("p.muted")?.remove();
    list.insertAdjacentHTML("beforeend", `<div class="row" data-sub-row="s-${Date.now()}" draggable="true"><span class="sub-grip" aria-hidden="true">⠿</span><input type="checkbox"><span data-sub-text>${esc(text)}</span><button type="button" data-sub-del aria-label="Delete subtask">×</button></div>`);
    input.value = "";
    input.focus();
    persistSubtasks(form);
  }));
  // Enter in the subtask box adds it (same as clicking Add) instead of
  // submitting the whole edit form.
  $$("[data-sub-new]", root).forEach((input) => input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.closest(".inline-add")?.querySelector("[data-add-sub-btn]")?.click();
  }));
  $$("[data-fab-capture]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const bodyText = (d.get("body") || "").trim();
    const files = d.getAll("photo").filter((x) => x && typeof x === "object" && "size" in x && x.size > 0);
    if (!bodyText && !files.length) return;
    // Same smart routing as the Inbox tab capture (stamp bo): a bare
    // link files to Reading, "task:" makes a task — unless files or a
    // title say it belongs in the inbox.
    if (!files.length && !(d.get("title") || "").trim() && routeCapture(bodyText) !== "inbox") { closePopup(); render(); saveBytes(); return; }
    const item = state.store.captureInbox({ title: d.get("title") || "", body: bodyText || "Photo" });
    for (const file of files) {
      try { const att = await fileToAttachment(file); state.store.addAttachment("inbox_items", item.id, att.mime, att.data, att.name ?? null); }
      catch { alert("An attachment could not be added."); }
    }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-fab-task]", root).forEach((f) => { wireSmartInput(f); f.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const title = (d.get("title") || "").trim();
    if (!title) return;
    const parsed = parseQuickTaskRich(title, f._suppress);
    state.store.createTask({ title: parsed.title, due: parsed.due ?? todayToronto(), priority: parsed.priority, project: d.get("project") || "General" });
    closePopup(); render(); saveBytes(); showToast("Task added");
  }); });
  $$("[data-fab-note]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (new FormData(f).get("jot") || "").trim();
    if (!text) return;
    try { await appendDailyLine(todayToronto(), text); } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes(); showToast("Added to today's daily note");
  }));
  $$("[data-fab-schedule]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const time = d.get("time"), text = (d.get("text") || "").trim();
    if (!time || !text) return;
    try { await appendDailyLine(todayToronto(), `${time} — ${text}`); } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes(); showToast("Added to today's schedule");
  }));
  $$("[data-move-category]", root).forEach((f) => f.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const id = d.get("inboxId");
    const from = d.get("from");
    const item = state.store.getRow("inbox_items", id);
    if (!item) { closePopup(); return; }
    const type = (d.get("categoryNew")?.trim()) || d.get("category") || "General Notes";
    try {
      state.engine.txn(() => {
        const note = state.store.createNote({ title: item.title || (item.body_markdown ?? "").split("\n")[0].slice(0, 60), body: item.body_markdown ?? "", type });
        if (note && note.type !== type) state.store.updateProps("notes", note.id, { type });
        if (note) state.store.reassignAttachments("inbox_items", id, "notes", note.id);
        state.store.archiveObject("inbox_items", id);
      });
      if (type && !vocabValues("notes", "type").includes(type)) state.store.addFieldValue("notes", "type", type);
    } catch (err) { alert(err.message); return; }
    closePopup();
    if (from === "page") state.itemView = null;
    render(); saveBytes();
  }));
  $$("[data-edit-task]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editTask;
    const d = new FormData(f);
    const project = d.get("project") === "__new__" ? (d.get("projectNew")?.trim() || null) : (d.get("project") || null);
    try {
      await saveBody("tasks", id, d.get("body"));
      state.store.updateProps("tasks", id, { title: d.get("title"), due_date: d.get("due") || null, priority: d.get("priority") || null, project });
      if (project && !vocabValues("tasks", "project").includes(project)) state.store.addFieldValue("tasks", "project", project);
      const parentId = d.get("parentId") || null;
      if (parentId !== state.store.getTaskParent(id)) state.store.setTaskParent(id, parentId);
      const recurrence = d.get("freq") ? { freq: d.get("freq"), interval: Number(d.get("interval") || 1), weekdays: d.getAll("wd").map(Number), endDate: d.get("end") || null, dayOfMonth: null } : "";
      state.store.setRecurrence(id, recurrence);
      state.store.setTags("tasks", id, (d.get("tags") || "").split(","));
      state.store.setSubtasks("tasks", id, readSubtasks(f));
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-edit-task]", root).forEach((f) => {
    const freq = f.querySelector("[name=freq]");
    const wd = f.querySelector("[data-rec-weekdays]");
    if (freq && wd) freq.addEventListener("change", () => { wd.hidden = freq.value !== "weekly"; });
  });
  $$("[data-edit-note]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editNote;
    const d = new FormData(f);
    const type = d.get("type") === "__new__" ? (d.get("typeNew")?.trim() || null) : (d.get("type") || null);
    try {
      await saveBody("notes", id, d.get("body"));
      state.store.updateProps("notes", id, { title: d.get("title"), type, date: d.get("date") || null });
      if (type && !vocabValues("notes", "type").includes(type)) state.store.addFieldValue("notes", "type", type);
      state.store.setTags("notes", id, (d.get("tags") || "").split(","));
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-edit-person]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editPerson;
    const d = new FormData(f);
    const role = d.get("role") === "__new__" ? (d.get("roleNew")?.trim() || null) : (d.get("role") || null);
    try {
      await saveBody("people", id, d.get("body"));
      state.store.updateProps("people", id, { title: d.get("title"), role });
      if (role && !vocabValues("people", "role").includes(role)) state.store.addFieldValue("people", "role", role);
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-edit-project]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editProject;
    const d = new FormData(f);
    const category = d.get("category") === "__new__" ? (d.get("categoryNew")?.trim() || null) : (d.get("category") || null);
    try {
      await saveBody("projects", id, d.get("body"));
      state.store.updateProps("projects", id, { title: d.get("title"), category, status: d.get("status") || null });
      if (category && !vocabValues("projects", "category").includes(category)) state.store.addFieldValue("projects", "category", category);
      state.store.setSubtasks("projects", id, readSubtasks(f));
      state.store.setRelatedTodos(id, d.getAll("todo"));
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  // "New …" dropdown options reveal their text field on the three
  // detail edit forms (task project, note type, project category).
  [["[data-edit-task]", "project", "projectNew"], ["[data-edit-note]", "type", "typeNew"], ["[data-edit-project]", "category", "categoryNew"], ["[data-edit-person]", "role", "roleNew"]].forEach(([formSel, selName, newName]) => {
    $$(formSel, root).forEach((f) => {
      const sel = f.querySelector(`[name="${selName}"]`);
      const nw = f.querySelector(`[name="${newName}"]`);
      if (sel && nw) sel.addEventListener("change", () => { nw.hidden = sel.value !== "__new__"; });
    });
  });
  $$("[data-link-subtask]", root).forEach((btn) => btn.addEventListener("click", async () => {
    const parentId = btn.dataset.linkSubtask;
    const childId = btn.closest("[data-link-subtask-wrap]")?.querySelector("[data-combo-value]")?.value ?? "";
    if (!childId) return;
    try {
      state.store.setTaskParent(childId, parentId);
    } catch (err) { alert(err.message); return; }
    render(); saveBytes(); openTaskPopup(parentId);
  }));
  $$("[data-todo-picker]", root).forEach((picker) => {
    const form = picker.closest("form");
    const input = picker.querySelector("[data-todo-filter]");
    const list = picker.querySelector("[data-todo-list]");
    const selected = form.querySelector("[data-todo-selected]");
    const tasks = allRows("tasks").slice().sort((a, b) => a.title.localeCompare(b.title));
    const selectedIds = () => [...selected.querySelectorAll('input[name="todo"]')].map((i) => i.value);
    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      const picked = new Set(selectedIds());
      const matches = tasks.filter((t) => !picked.has(t.id) && (!q || t.title.toLowerCase().includes(q)));
      const shown = matches.slice(0, 50);
      list.innerHTML = shown.map((t) => `<button type="button" data-todo-add="${t.id}">${esc(t.title)}</button>`).join("") + (matches.length > 50 ? `<p class="muted" style="padding:8px 12px">Showing first 50 of ${matches.length} matches.</p>` : "") + (shown.length === 0 ? `<p class="muted" style="padding:8px 12px">No matches.</p>` : "");
      list.hidden = false;
    };
    input.addEventListener("input", renderList);
    input.addEventListener("focus", renderList);
    input.addEventListener("blur", () => { setTimeout(() => { list.hidden = true; }, 150); });
    list.addEventListener("mousedown", (e) => {
      const btn = e.target.closest("[data-todo-add]");
      if (!btn) return;
      e.preventDefault();
      const t = tasks.find((x) => x.id === btn.dataset.todoAdd);
      if (!t) return;
      selected.insertAdjacentHTML("beforeend", `<div class="row"><span class="row-title">${esc(t.title)}</span><input type="hidden" name="todo" value="${t.id}"><button type="button" data-todo-remove>✕</button></div>`);
      input.value = "";
      renderList();
      input.focus();
    });
    selected.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-todo-remove]");
      if (btn) btn.closest(".row")?.remove();
    });
  });
  $$("[data-edit-reading]", root).forEach((f) => bindLinkTitle(f));
  $$("[data-edit-reading]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editReading;
    const d = new FormData(f);
    const url = d.get("url").trim();
    let source = "";
    try { source = new URL(url).hostname.replace(/^www\./, ""); } catch { source = ""; }
    try {
      await saveBody("reading_items", id, d.get("body"));
      state.store.updateProps("reading_items", id, { title: d.get("title"), url, status: d.get("status"), source });
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-edit-inbox]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = f.dataset.editInbox;
    const d = new FormData(f);
    try {
      await saveBody("inbox_items", id, d.get("body"));
      state.store.updateProps("inbox_items", id, { title: d.get("title") });
    } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
  $$("[data-add-link]", root).forEach((f) => {
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const [fromType, fromId] = f.dataset.addLink.split(":");
      const target = new FormData(f).get("linkTarget") || "";
      const sep = target.indexOf(":");
      if (sep < 1) { alert("Search and pick an item to link first."); return; }
      try { state.store.addLink(fromType, fromId, target.slice(0, sep), target.slice(sep + 1)); } catch (err) { alert(err.message); return; }
      render(); saveBytes(); openPopupByRef(fromType, fromId);
    });
  });
}

function attachPersistentListeners() {
  // Password managers: keep autofill out of every field. Fields are
  // stamped the moment they enter the DOM (an observer), not just on
  // focus — by focus time the autofill session has already started
  // (stamp cp; the cg focus-only version was not enough).
  const stampNoAutofill = (el) => { el.setAttribute("autocomplete", "off"); el.setAttribute("data-1p-ignore", "true"); el.setAttribute("data-lpignore", "true"); };
  const stampTree = (root) => {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === "INPUT" || root.tagName === "TEXTAREA" || root.tagName === "FORM") stampNoAutofill(root);
    root.querySelectorAll?.("input, textarea, form").forEach(stampNoAutofill);
  };
  stampTree(document.body ?? document);
  if (typeof MutationObserver === "function") {
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) stampTree(n); }).observe(document.documentElement, { childList: true, subtree: true });
  }
  document.addEventListener("focusin", (e) => { const el = e.target; if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) stampNoAutofill(el); });
  // Sync on return (stamp bz): coming back to the app/tab pulls
  // anything that changed elsewhere instead of sitting stale until
  // the next edit or manual sync. Throttled; doSync self-guards.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.booted || !state.transport?.token) return;
    if (state.lastResumeSync && Date.now() - state.lastResumeSync < 20000) return;
    state.lastResumeSync = Date.now();
    doSync();
  });
  // Swipe left on a task row toggles it done. The row's checkbox and
  // popup still work if a swipe never fires; a detected swipe kills
  // the synthetic tap click so the popup does not open.
  let swRow = null, swX = null, swY = null, swMoved = false, swAxis = null;
  // Reveal-and-confirm swipe (stamp bn): a slide no longer fires the
  // action. Past 56px the row snaps open and a labelled button sits
  // in the vacated strip; only pressing that button acts. Any other
  // tap dismisses. (Ben: firing on release still felt too sensitive.)
  let swOpenRow = null, swZone = null, swKillClick = false, swOpenedAt = 0;
  function closeSwipe() {
    if (!swOpenRow) return;
    const r = swOpenRow; swOpenRow = null;
    r.style.transition = "transform .18s";
    r.style.transform = "";
    setTimeout(() => { r.style.transition = ""; }, 200);
    r.querySelector(".swipe-act")?.remove();
  }
  function makeSwipeZone(row, dir) {
    const task = state.store.getRow("tasks", row.dataset.task);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swipe-act " + (dir > 0 ? "snooze" : "done");
    b.dataset.swipeAct = dir > 0 ? "snooze" : "done";
    b.textContent = dir > 0 ? "🌙 +1 day" : (task?.done ? "↩ Undo" : "✓ Done");
    b.style[dir > 0 ? "left" : "right"] = "0";
    row.appendChild(b);
    return b;
  }
  $("#main").addEventListener("touchstart", (e) => {
    if (e.target.closest?.("[data-swipe-act]")) return; // the confirm tap itself
    const row = e.target.closest?.("[data-task]");
    if (swOpenRow) {
      const wasOpen = swOpenRow;
      closeSwipe();
      if (row === wasOpen) { swKillClick = true; swRow = null; swX = null; return; }
    }
    if (!row || e.touches.length !== 1) { swRow = null; swX = null; return; }
    row.style.transition = "";
    swRow = row; swX = e.touches[0].clientX; swY = e.touches[0].clientY; swMoved = false; swAxis = null; swZone = null;
  }, { passive: true });
  $("#main").addEventListener("touchmove", (e) => {
    if (!swRow || swX === null) return;
    const dx = e.touches[0].clientX - swX;
    const dy = e.touches[0].clientY - swY;
    // Axis lock (stamp as): a mostly-vertical gesture is a scroll, not
    // a swipe. Horizontal intent needs a 16px dead zone with dx
    // clearly dominant before the row starts moving at all.
    if (swAxis === null) {
      if (Math.abs(dy) > 24 && Math.abs(dy) > Math.abs(dx)) { swRow.style.transform = ""; swZone?.remove(); swZone = null; swRow = null; swX = null; return; }
      if (Math.abs(dx) > 16 && Math.abs(dx) > Math.abs(dy)) swAxis = "x";
      else return;
    }
    const clamped = Math.max(-110, Math.min(110, dx));
    swRow.style.transform = `translateX(${clamped}px)`;
    // The action zone stays pinned at the row's original edge
    // (counter-translated) so the content slides away from it.
    const dir = dx >= 0 ? 1 : -1;
    if (!swZone || (swZone.dataset.swipeAct === "snooze") !== (dir > 0)) { swZone?.remove(); swZone = makeSwipeZone(swRow, dir); }
    swZone.style.transform = `translateX(${-clamped}px)`;
    swMoved = true;
  }, { passive: true });
  // Stickiness (stamp br): the synthetic click a WebView fires right
  // after the swipe's touchend used to land on the just-opened row
  // and dismiss it instantly — the row never stayed open to press.
  // Swallow non-button clicks for a short window after opening, and
  // reset cleanly if the browser cancels the gesture.
  $("#main").addEventListener("click", (e) => {
    if (swOpenRow && Date.now() - swOpenedAt < 450 && !e.target.closest?.("[data-swipe-act]")) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  document.addEventListener("scroll", () => closeSwipe(), { capture: true, passive: true });
  $("#main").addEventListener("touchcancel", () => {
    if (swRow) { swRow.style.transform = ""; swZone?.remove(); }
    swRow = null; swX = null; swY = null; swMoved = false; swAxis = null; swZone = null;
  }, { passive: true });
  $("#main").addEventListener("touchend", (e) => {
    if (swKillClick) { e.preventDefault(); swKillClick = false; return; }
    if (!swRow) return;
    const m = /translateX\((-?[\d.]+)px\)/.exec(swRow.style.transform || "");
    const dx = m ? parseFloat(m[1]) : 0;
    const row = swRow, zone = swZone, wasMoved = swMoved;
    swRow = null; swX = null; swY = null; swMoved = false; swAxis = null; swZone = null;
    // (Stamp bt: wasMoved is captured BEFORE the reset — the bn code
    // tested swMoved after zeroing it, so the open branch was dead
    // and every swipe snapped shut on release.)
    if (wasMoved && Math.abs(dx) >= 56) {
      e.preventDefault(); // kill the synthetic tap so it can't dismiss or open
      const dir = dx > 0 ? 1 : -1;
      const z = zone ?? makeSwipeZone(row, dir);
      row.style.transition = "transform .18s";
      row.style.transform = `translateX(${dir * 96}px)`;
      z.style.transition = "transform .18s";
      z.style.transform = `translateX(${-dir * 96}px)`;
      setTimeout(() => { row.style.transition = ""; z.style.transition = ""; }, 200);
      swOpenRow = row; swOpenedAt = Date.now();
    } else {
      row.style.transform = "";
      zone?.remove();
    }
  }, { passive: false });
  $("#main").addEventListener("click", async (e) => {
    const swAct = e.target.closest("[data-swipe-act]");
    if (swAct) {
      const id = swAct.closest("[data-task]")?.dataset.task;
      closeSwipe(); buzz();
      if (id) {
        const t = state.store.getRow("tasks", id);
        if (t) {
          if (swAct.dataset.swipeAct === "done") {
            if (!t.done) beginTickGrace(id);
            else state.store.updateProps("tasks", id, { done: 0 });
          } else if (!t.done) {
            const today = todayToronto();
            const base = t.due_date && t.due_date > today ? t.due_date : today;
            state.store.updateProps("tasks", id, { due_date: ymdAdd(base, 1) });
          }
          render(); saveBytes();
        }
      }
      return;
    }
    if (swOpenRow) { if (Date.now() - swOpenedAt < 450) return; closeSwipe(); return; }
    const tick = e.target.closest("[data-tick]");
    if (tick) {
      const id = tick.dataset.tick;
      if (cancelTickGrace(id)) { buzz(); render(); return; }
      const row = state.store.getRow("tasks", id);
      if (!row.done) { beginTickGrace(id); buzz(); render(); }
      else { state.store.updateProps("tasks", id, { done: 0 }); buzz(); render(); saveBytes(); }
      return;
    }
    const readingDone = e.target.closest("[data-reading-done]");
    if (readingDone) {
      state.store.updateProps("reading_items", readingDone.dataset.readingDone, { status: "Read" });
      if (!vocabValues("reading_items", "status").includes("Read")) state.store.addFieldValue("reading_items", "status", "Read");
      render(); saveBytes();
      return;
    }
    const calMode = e.target.closest("[data-cal-mode]");
    if (calMode) { calState().mode = calMode.dataset.calMode; render(); return; }
    const calNav = e.target.closest("[data-cal-nav]");
    if (calNav) {
      const v = calState();
      const [yy, mm] = v.month.split("-").map(Number);
      const t = new Date(Date.UTC(yy, mm - 1 + parseInt(calNav.dataset.calNav, 10), 1));
      v.month = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`;
      render();
      return;
    }
    const calTodayBtn = e.target.closest("[data-cal-today]");
    if (calTodayBtn) { const v = calState(); const td = todayToronto(); v.month = td.slice(0, 7); v.selected = td; render(); return; }
    const calDay = e.target.closest("[data-cal-day]");
    if (calDay && !e.target.closest("[data-open]")) { calState().selected = calDay.dataset.calDay; render(); return; }
    const calRetry = e.target.closest("[data-cal-retry]");
    if (calRetry) { loadCalRange(true); return; }
    const famBtn = e.target.closest("[data-fam-refresh]");
    if (famBtn) { loadFamilyCalendar(true); return; }
    const mdDl = e.target.closest("[data-md-download]");
    if (mdDl) { const v = parsePageRef(mdDl.dataset.mdDownload); const row = v.type === "custom" ? state.store.getRow("custom_objects", v.id) : state.store.getRow(v.type, v.id); if (row) downloadBytes(`${slugify(row.title)}.md`, new TextEncoder().encode(objectToMarkdown(v.type, row)), "text/markdown"); return; }
    const pinOpen = e.target.closest("[data-pin-open]");
    if (pinOpen) { openPageRef(pinOpen.dataset.pinOpen); return; }
    const pinBtn = e.target.closest("[data-pin-toggle]");
    if (pinBtn) {
      togglePin(pinBtn.dataset.pinToggle);
      render(); saveBytes();
      return;
    }
    const dupTask = e.target.closest("[data-duplicate-task]");
    if (dupTask) { duplicateTask(dupTask.dataset.duplicateTask); return; }
    const dupNote = e.target.closest("[data-duplicate-note]");
    if (dupNote) { duplicateNote(dupNote.dataset.duplicateNote); return; }
    const open = e.target.closest("[data-open]");
    if (open) {
      const [type, id] = open.dataset.open.split(":");
      openPopupByRef(type, id);
      return;
    }
    const taskRow = e.target.closest("[data-task]");
    if (taskRow && !e.target.closest("input,button,select")) { openTaskPopup(taskRow.dataset.task); return; }
    const noteRow = e.target.closest("[data-note]");
    if (noteRow) { openNotePopup(noteRow.dataset.note); return; }
    const personRow = e.target.closest("[data-person]");
    if (personRow) { openPersonPopup(personRow.dataset.person); return; }
    const readingTitle = e.target.closest("[data-reading]");
    if (readingTitle) { openReadingPopup(readingTitle.dataset.reading); return; }
    const projectRow = e.target.closest("[data-project]");
    if (projectRow) { openProjectPopup(projectRow.dataset.project); return; }
    if (state.inboxBulk) { const bulkRow = e.target.closest("[data-inbox]"); if (bulkRow && !e.target.closest("[data-archive-inbox]") && !e.target.closest("[data-inbox-sel]")) { const s = (state.inboxSel ??= new Set()); if (s.has(bulkRow.dataset.inbox)) s.delete(bulkRow.dataset.inbox); else s.add(bulkRow.dataset.inbox); render(); return; } }
    const inboxRow = e.target.closest("[data-inbox]");
    if (inboxRow && !e.target.closest("button")) { openInboxPopup(inboxRow.dataset.inbox); return; }
    const archI = e.target.closest("[data-archive-inbox]");
    if (archI) { archiveWithUndo("inbox_items", archI.dataset.archiveInbox); render(); saveBytes(); return; }
  });
  $("#main").addEventListener("change", async (e) => {
    const pillInput = e.target.closest("[data-pill-color]");
    if (pillInput) {
      const v = pillInput.dataset.pillColor; const i = v.indexOf("|");
      setPillColor(v.slice(0, i), v.slice(i + 1), pillInput.value);
      render(); saveBytes();
      return;
    }
    const sel = e.target.closest("[data-reading-status]");
    if (sel) {
      state.store.updateProps("reading_items", sel.dataset.readingStatus, { status: sel.value });
      render(); saveBytes();
    }
  });
  $("#popup-root").addEventListener("click", async (e) => {
    if (e.target.classList.contains("popup-backdrop")) { savePopupAndClose(); return; }
    const pinBtnP = e.target.closest("[data-pin-toggle]");
    if (pinBtnP) { togglePin(pinBtnP.dataset.pinToggle); render(); saveBytes(); refreshOpenPopup(); return; }
    if (e.target.closest("[data-close-popup]")) { closePopup(); return; }
    const pageOpen = e.target.closest("[data-open-page]");
    if (pageOpen) { closePopup(); openPageRef(pageOpen.dataset.openPage); return; }
    const skip = e.target.closest("[data-skip]");
    if (skip) { state.store.skipTaskOccurrence(skip.dataset.skip, todayToronto()); closePopup(); render(); saveBytes(); return; }
    const stop = e.target.closest("[data-stop]");
    if (stop) { state.store.stopRecurrence(stop.dataset.stop); render(); saveBytes(); openTaskPopup(stop.dataset.stop); return; }
    const sendT = e.target.closest("[data-send-tony]");
    if (sendT) { doSendTony(sendT.dataset.sendTony); return; }
    const shareT = e.target.closest("[data-share-tony]");
    if (shareT) { doShareTony(shareT.dataset.shareTony); return; }
    const arch = e.target.closest("[data-archive-task],[data-archive-note],[data-archive-person],[data-archive-project],[data-archive-reading],[data-archive-inbox]");
    if (arch) {
      const table = arch.dataset.archiveTask ? "tasks" : arch.dataset.archiveNote ? "notes" : arch.dataset.archivePerson ? "people" : arch.dataset.archiveProject ? "projects" : arch.dataset.archiveReading ? "reading_items" : "inbox_items";
      const id = arch.dataset.archiveTask ?? arch.dataset.archiveNote ?? arch.dataset.archivePerson ?? arch.dataset.archiveProject ?? arch.dataset.archiveReading ?? arch.dataset.archiveInbox;
      archiveWithUndo(table, id);
      closePopup(); render(); saveBytes();
      return;
    }
    const move = e.target.closest("[data-move-personal]");
    if (move) {
      const item = state.store.getRow("inbox_items", move.dataset.movePersonal);
      if (item) openMoveCategoryPrompt(item, "popup");
      return;
    }
    const rmLink = e.target.closest("[data-remove-link]");
    if (rmLink) {
      const [fromType, fromId, toType, toId] = rmLink.dataset.removeLink.split(":");
      state.store.removeLink(fromType, fromId, toType, toId);
      render(); saveBytes(); openPopupByRef(fromType, fromId);
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) {
      const [type, id] = open.dataset.open.split(":");
      openPopupByRef(type, id);
      return;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopup();
  });
}

// --- Boot ---

// Instant boot paint (stamp ce): the last rendered dashboard is
// cached and repainted the moment boot starts, so the app opens on
// real content instead of a second of "Loading local database\u2026".
// The preview is inert (pointer-events off via body.boot-preview)
// and the first live render replaces it.
function paintBootPreview() {
  try {
    const raw = localStorage.getItem("dashben-boot-html");
    if (!raw) return;
    let tab = "dashboard", html = raw;
    try { const j = JSON.parse(raw); if (j && j.html) { tab = j.tab || "dashboard"; html = j.html; } } catch { /* legacy plain-html cache */ }
    const want = "daily"; // the app always opens on Daily (stamp cg)
    if (tab !== want) return;
    const main = document.querySelector("#main");
    if (main) { main.innerHTML = html; document.body.classList.add("boot-preview"); }
  } catch { /* preview is optional */ }
}
let bootHtmlTimer = null;
function cacheBootHtml(html) {
  if (bootHtmlTimer) return;
  bootHtmlTimer = setTimeout(() => { bootHtmlTimer = null; try { localStorage.setItem("dashben-boot-html", html); } catch { /* quota */ } }, 400);
}
async function boot() {
  paintBootPreview();
  resolveNativePlugins();
  loadSettings();
  await loadSecureToken();
  // Stamp cw: with no token the app opens on a connect screen instead
  // of an empty Daily tab (render() gates on this flag).
  state.needsToken = !state.token;
  // The WASM binary ships as base64 text (vendor/sql-wasm.wasm.b64)
  // because the repo push tooling only accepts UTF-8 files, so the
  // binary .wasm itself is never committed. Decoded here and handed
  // to sql.js directly — same self-hosted bytes, no CDN.
  const b64 = await (await fetch("./vendor/sql-wasm.wasm.b64")).text();
  const bin = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  const SQL = await initSqlJs({ wasmBinary: bin });
  const schema = await (await fetch(SCHEMA_URL)).text();
  const bytes = await loadBytes();
  let fresh = false;
  if (bytes) {
    state.db = new SqlJsDb(SQL, bytes);
  } else {
    state.db = new SqlJsDb(SQL);
    state.db.exec(schema);
    fresh = true;
  }
  state.engine = new SyncEngine(state.db);
  state.store = new LocalStore(state.engine);
  state.transport = new HttpTransport(state.base, state.token);
  state.booted = !fresh || !!bytes;
  state.bootMs = Math.round((typeof performance !== "undefined" ? performance.now() : 0) - BOOT_T0);
  try { state.db.exec(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT, archived INTEGER NOT NULL DEFAULT 0)`); } catch {}
  try { const cols = state.db.prepare(`PRAGMA table_info(attachments)`).all(); if (cols.length && !cols.some((c) => c.name === "name")) state.db.exec(`ALTER TABLE attachments ADD COLUMN name TEXT`); } catch {}
  ensureSearchIndex();
  const origLocalWrite = state.engine.localWrite.bind(state.engine);
  // Sync-after-write: edits push within seconds when online, instead
  // of waiting for launch/reconnect/manual Sync. Debounced so a
  // multi-write save (body + props) syncs once; if a sync is running
  // when the timer fires, it re-arms instead of dropping the edit.
  // Skipped offline, tokenless, or before the first full sync.
  let syncTimer = null;
  function scheduleSync() {
    if (!state.token || !state.booted || !navigator.onLine) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { if (state.syncing) scheduleSync(); else doSync(); }, 3000);
  }
  state.engine.localWrite = (...args) => { const r = origLocalWrite(...args); state.searchDirty = true; scheduleSync(); return r; };
  state.searchDirty = true;
  applyTheme();
  // Tabs
  $$(".tab-btn").forEach((b) => b.addEventListener("click", () => { $("#sidebar").classList.remove("open"); if (b.dataset.tab === state.tab && !state.itemView && b.closest("#bottom-nav")) { window.scrollTo({ top: 0, behavior: "smooth" }); return; } state.tab = b.dataset.tab; state.itemView = null; saveTab(); render(); }));
  $("#sync-btn").addEventListener("click", doSync);
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#collapse-btn")?.addEventListener("click", () => {
    const on = document.body.classList.toggle("nav-collapsed");
    $("#collapse-btn").textContent = on ? "»" : "«";
    try { const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}"); s.navCollapsed = on; localStorage.setItem("pkm-local-settings", JSON.stringify(s)); } catch {}
  });
  document.addEventListener("change", async (e) => {
    const input = e.target.closest?.("[data-photo-add]");
    if (!input || !input.files?.length) return;
    const [ownerType, ownerId] = input.dataset.photoAdd.split(":");
    const inPopup = !!input.closest("#popup-root");
    try { for (const file of input.files) { const att = await fileToAttachment(file); state.store.addAttachment(ownerType, ownerId, att.mime, att.data, att.name ?? null); } }
    catch { alert("An attachment could not be added."); }
    render(); saveBytes();
    if (inPopup) refreshOpenPopup();
  });
  document.addEventListener("click", (e) => {
    const view = e.target.closest?.("[data-photo-view]");
    if (view) {
      const grid = view.closest("[data-photo-owner]");
      const [ot, oi] = (grid?.dataset.photoOwner || "").split(":");
      if (ot && oi) showLightbox(ot, oi, view.dataset.photoView);
      return;
    }
    if (e.target.closest?.("[data-lb-close]") || e.target.classList?.contains("lightbox")) { lbState = null; renderLightbox(); return; }
    if (e.target.closest?.("[data-lb-prev]") && lbState) { lbState.idx = (lbState.idx - 1 + lbState.list.length) % lbState.list.length; renderLightbox(); return; }
    if (e.target.closest?.("[data-lb-next]") && lbState) { lbState.idx = (lbState.idx + 1) % lbState.list.length; renderLightbox(); return; }
    const del = e.target.closest?.("[data-del-attachment]");
    if (!del) return;
    const inPopup = !!del.closest("#popup-root");
    try { state.store.archiveAttachment(del.dataset.delAttachment); } catch {}
    render(); saveBytes();
    if (inPopup) refreshOpenPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (!lbState) return;
    if (e.key === "Escape") { lbState = null; renderLightbox(); }
    else if (e.key === "ArrowLeft") { lbState.idx = (lbState.idx - 1 + lbState.list.length) % lbState.list.length; renderLightbox(); }
    else if (e.key === "ArrowRight") { lbState.idx = (lbState.idx + 1) % lbState.list.length; renderLightbox(); }
  });
  $("#palette-btn")?.addEventListener("click", () => openPalette());
  $("#feed-btn")?.addEventListener("click", () => { state.tab = "feed"; state.itemView = null; saveTab(); render(); });
  $("#toast-root")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-toast-undo]")) { const u = toastUndo; toastUndo = null; if (u) u(); }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); if (paletteState) closePalette(); else openPalette(); return; }
    if (!paletteState) return;
    if (e.key === "Escape") { closePalette(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = paletteState.entries?.length ?? 0;
      if (n) { paletteState.active = (paletteState.active + (e.key === "ArrowDown" ? 1 : -1) + n) % n; updatePaletteList(); }
      return;
    }
    if (e.key === "Enter" && document.activeElement?.id === "palette-input") { e.preventDefault(); runPaletteEntry(paletteState.active); }
  });
  $("#palette-root")?.addEventListener("click", (e) => {
    if (e.target.hasAttribute?.("data-palette-backdrop")) { closePalette(); return; }
    const item = e.target.closest?.("[data-palette-idx]");
    if (item) runPaletteEntry(Number(item.dataset.paletteIdx));
  });
  // (stamp bm: the bottom-bar More button is gone — the drawer opens from the header #menu-btn.)
  // FAB menu (stamp bg): the + button opens a small action menu —
  // Capture (inbox capture), Task (quick add), Quick Note (jot into
  // today's daily note). Tapping anywhere else dismisses it.
  const fabMenu = $("#fab-menu");
  const hideFabMenu = () => { if (fabMenu) fabMenu.hidden = true; };
  $("#fab-capture").addEventListener("click", (e) => { e.stopPropagation(); if (fabMenu) fabMenu.hidden = !fabMenu.hidden; });
  document.addEventListener("click", (e) => {
    const act = e.target.closest?.("[data-fab-menu]")?.dataset.fabMenu;
    if (!act) { if (!e.target.closest?.("#fab-menu") && !e.target.closest?.("#fab-capture")) hideFabMenu(); return; }
    hideFabMenu();
    if (act === "capture") openPopup("Capture", `<form data-fab-capture class="form"><input name="title" placeholder="Title (optional)"><textarea name="body" rows="4" placeholder="Capture…"></textarea><input type="file" name="photo" accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.rtf" multiple><p class="popup-actions"><button type="submit" class="primary-btn">Capture</button><button type="button" data-close-popup class="ghost-btn">Cancel</button></p></form>`);
    else if (act === "task") { openPopup("Quick add task", `<form data-fab-task class="form"><span class="hl-wrap"><span class="hl-back"></span><input class="hl-input" name="title" placeholder="New task — try 'Fri P1'" required></span>${quickProjectSelect()}<span class="parse-chips"></span><p class="popup-actions"><button type="submit" class="primary-btn">Add task</button><button type="button" data-close-popup class="ghost-btn">Cancel</button></p></form>`); setTimeout(() => $("#popup-root input[name=title]")?.focus(), 40); }
    else if (act === "schedule") { openPopup("Add to schedule", `<form data-fab-schedule class="form"><input type="time" name="time" required><input name="text" placeholder="e.g. Meeting with…" required style="flex:1"><p class="popup-actions"><button type="submit" class="primary-btn">Add to schedule</button><button type="button" data-close-popup class="ghost-btn">Cancel</button></p></form>`); setTimeout(() => $("#popup-root input[name=text]")?.focus(), 40); }
    else if (act === "note") { openPopup("Quick note", `<form data-fab-note class="form"><textarea name="jot" rows="3" placeholder="Jot a note for today…" required style="flex:1"></textarea><p class="popup-actions"><button type="submit" class="primary-btn">Jot it down</button><button type="button" data-close-popup class="ghost-btn">Cancel</button></p></form>`); setTimeout(() => $("#popup-root textarea[name=jot]")?.focus(), 40); }
  });
  // "Auto (system)" theme follows the OS; re-apply when it flips.
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyTheme);
  // Pull-to-refresh (shell only, additive: Sync now still works if a
  // pull never fires). Only at the very top, no popup open, online.
  let ptrY = null, ptrDy = 0;
  const ptrEl = document.getElementById("ptr-indicator");
  document.addEventListener("touchstart", (e) => {
    if (window.scrollY <= 0 && !$("div#popup-root").firstChild && e.touches.length === 1) { ptrY = e.touches[0].clientY; ptrDy = 0; }
    else ptrY = null;
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (ptrY === null) return;
    ptrDy = e.touches[0].clientY - ptrY;
    if (ptrDy > 0) {
      ptrEl.textContent = ptrDy > 70 ? "Release to sync…" : "Pull to sync…";
      ptrEl.classList.add("show");
    } else ptrEl.classList.remove("show");
  }, { passive: true });
  document.addEventListener("touchend", () => {
    if (ptrY !== null && ptrDy > 70 && state.token && navigator.onLine && !state.syncing) doSync();
    ptrEl.classList.remove("show");
    ptrY = null; ptrDy = 0;
  }, { passive: true });
  // Auto-sync on reconnect: coming back online pushes queued local
  // edits and pulls anything that landed server-side while offline.
  window.addEventListener("online", () => { render(); if (state.booted) doSync(); });
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { shellHiddenAt = Date.now(); return; }
    captureSharedText();
    void checkWidgetAction();
    void processWidgetDone();
    queueWidgetSnapshot();
    if (shellHiddenAt && Date.now() - shellHiddenAt > 60000) maybeLockApp();
    shellHiddenAt = 0;
  });
  attachPersistentListeners();
  attachExtraListeners();
  // Reload lands on the tab that was open, not always the dashboard.
  try {
    const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    state.tab = "daily"; // Ben: always open on the Daily tab (stamp cg)
  } catch {}
  try {
    const s0 = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    if (s0.navCollapsed) { document.body.classList.add("nav-collapsed"); const cb = $("#collapse-btn"); if (cb) cb.textContent = "»"; }
  } catch {}
  initNav();
  loadFamilyCalendar();
  render();
  document.body?.classList.add("booted");
  await captureSharedText();
  // Auto-sync on launch when we already have local state; on a fresh
  // database, first sync runs on the first manual Sync press (so a
  // missing token doesn't block first paint).
  if (!fresh) await doSync();
  void initReminders();
  processPendingNotifActions();
  void processWidgetDone();
  maybeLockApp();
  queueWidgetSnapshot();
  void checkWidgetAction();
}

boot().catch((e) => {
  document.querySelector("#main").innerHTML = `<p class="error">Failed to start: ${esc(e.message)}</p>`;
});

// --- Parity P2/P3/P4/P6: Daily, Management, custom types, FTS, themes ---
const DEFAULT_TABS = ["dashboard", "daily", "calendar", "tasks", "notes", "projects", "reading", "feed", "people", "inbox", "search", "management"]; // Review tab removed on mobile (stamp bc)
const TAB_LABELS = { dashboard: "Dashboard", daily: "Daily", calendar: "Calendar", review: "Review", tasks: "Tasks", notes: "Notes", projects: "Projects", reading: "Reading", feed: "Feed", people: "People", inbox: "Inbox", search: "Search", management: "Management" };
const MANAGED_FIELD_LIST = [
  ["tasks", "priority"], ["tasks", "project"], ["notes", "type"], ["people", "role"],
  ["reading_items", "status"], ["projects", "status"], ["projects", "category"],
];
const THEMES = [["auto", "Auto (system)"], ["blueprint", "Blueprint dark"], ["linear-light", "Linear light"], ["paper", "Paper light"], ["civic", "Civic"], ["minimal", "Minimal light"], ["notebook", "Field notebook"], ["ember", "Ember dark"]];

function getTabPrefs() {
  try {
    const row = state.store.getRow("ui_prefs", "tabs");
    if (!row?.value) return { order: [...DEFAULT_TABS], hidden: [], rearrangeEnabled: true, groups: [] };
    const p = JSON.parse(row.value);
    const order = Array.isArray(p.order) ? p.order : [...DEFAULT_TABS];
    const missing = DEFAULT_TABS.filter((t) => !order.includes(t));
    if (missing.length) { const i = order.indexOf("daily"); order.splice(i >= 0 ? i + 1 : order.length, 0, ...missing); }
    return { order, hidden: Array.isArray(p.hidden) ? p.hidden : [], rearrangeEnabled: true, groups: Array.isArray(p.groups) ? p.groups : [] };
  } catch { return { order: [...DEFAULT_TABS], hidden: [], rearrangeEnabled: true, groups: [] }; }
}
function customTabDefs() {
  return state.db.prepare("SELECT * FROM custom_object_types WHERE has_tab=1 ORDER BY name").all();
}
function allTabIds() {
  return [...DEFAULT_TABS, ...customTabDefs().map((t) => `custom:${t.slug}`)];
}
function tabLabel(id) {
  if (id.startsWith("custom:")) {
    const def = state.store.getRow("custom_object_types", id.slice(7));
    return def ? def.name : id;
  }
  return TAB_LABELS[id] ?? id;
}
function renderSidebar() {
  const card = document.querySelector(".menu-card");
  if (!card) return;
  // Ensure a button exists for every custom tab (built-ins ship in HTML).
  for (const t of customTabDefs()) {
    if (!card.querySelector(`[data-tab="custom:${t.slug}"]`)) {
      const btn = document.createElement("button");
      btn.className = "tab-btn";
      btn.dataset.tab = `custom:${t.slug}`;
      btn.innerHTML = `<span>${esc(t.name)}</span>`;
      btn.addEventListener("click", () => { state.tab = `custom:${t.slug}`; state.itemView = null; saveTab(); render(); });
      card.appendChild(btn);
    }
  }
  // Unwrap previous groups (buttons survive; only wrappers/labels go).
  card.querySelectorAll(".menu-group").forEach((w) => {
    [...w.children].forEach((ch) => { if (ch.classList.contains("tab-btn")) card.appendChild(ch); });
    w.remove();
  });
  const btns = new Map();
  card.querySelectorAll(".tab-btn").forEach((b) => btns.set(b.dataset.tab, b));
  const prefs = getTabPrefs();
  const known = allTabIds();
  const order = [...prefs.order.filter((id) => known.includes(id)), ...known.filter((id) => !prefs.order.includes(id))];
  const grouped = new Map();
  for (const g of prefs.groups) for (const tid of g.tabs ?? []) grouped.set(tid, g);
  const built = new Map();
  for (const id of order) {
    const btn = btns.get(id);
    if (!btn) continue;
    const g = grouped.get(id);
    if (g) {
      if (!built.has(g.id)) {
        const wrap = document.createElement("div");
        wrap.className = "menu-group" + (g.collapsed ? " collapsed" : "");
        const lab = document.createElement("div");
        lab.className = "menu-group-label";
        lab.textContent = (g.collapsed ? "▸ " : "▾ ") + g.label;
        lab.addEventListener("click", async () => {
          const p = getTabPrefs();
          const gg = p.groups.find((x) => x.id === g.id);
          if (gg) { gg.collapsed = !gg.collapsed; state.store.setTabPrefs(p); render(); saveBytes(); }
        });
        wrap.appendChild(lab);
        built.set(g.id, wrap);
        card.appendChild(wrap);
      }
      built.get(g.id).appendChild(btn);
    } else {
      card.appendChild(btn);
    }
  }
}

function applyTheme() {
  let theme = state.store.getRow("ui_prefs", "theme")?.value ?? "ember";
  if (theme === "auto") theme = window.matchMedia("(prefers-color-scheme: light)").matches ? "paper" : "blueprint";
  if (theme === "blueprint") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  // Mirror the resolved theme to localStorage (stamp cc): an inline
  // script in index.html applies it before first paint, so the app
  // no longer flashes the default theme while the database loads.
  try { localStorage.setItem("dashben-theme", theme); } catch { /* private mode */ }
}

function dailyNoteFor(date) {
  const rows = state.db.prepare("SELECT * FROM notes WHERE archived=0 AND date=? ORDER BY updated_at DESC LIMIT 1").all(date);
  return rows[0] ?? null;
}
function splitSchedule(body) {
  const schedule = [], notes = [];
  for (const line of (body ?? "").split("\n")) {
    if (/^\d{1,2}:\d{2}\s*[—–-]/.test(line.trim())) schedule.push(line);
    else notes.push(line);
  }
  return { schedule, notes };
}
function renderDaily() {
  const date = state.dailyDate || todayToronto();
  const note = dailyNoteFor(date);
  const todos = sortByPrio(openTasks().filter((t) => t.due_date === date));
  const overdue = sortByPrio(openTasks().filter((t) => t.due_date && t.due_date < date));
  let body = "";
  if (note) {
    const { schedule, notes } = splitSchedule(note.body_markdown ?? "");
    body = `<div class="panel"><h3>Schedule</h3>${schedule.length ? schedule.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No schedule entries yet (lines starting with a time, like 9:00 — Meeting).</p>"}</div>
    <div class="panel"><h3>Notes</h3>${notes.join("\n").trim() ? notes.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No notes yet.</p>"}</div>
    ${familyPanel()}
    <p><button data-open="notes:${note.id}">Edit daily note</button></p>`;
  } else {
    body = `<p class="muted">No daily note for this date yet.</p>
    ${familyPanel()}<p><button data-create-daily="${date}" class="primary-btn">Create daily note for ${date}</button></p>`;
  }
  return `<form data-daily-nav class="form">
    <button type="button" data-daily-shift="-1"><span class="nav-arrow">← </span>Prev</button>
    <input type="date" name="date" value="${date}" data-daily-date>
    <button type="button" data-daily-go>Go</button>
    <button type="button" data-daily-shift="1">Next <span class="nav-arrow">→</span></button>
    <button type="button" data-daily-shift="0">Today</button>
  </form>
  ${dayContextPanel(date)}
  <div class="panel"><h3>Overdue (${overdue.length})</h3>${date === todayToronto() && overdue.length ? ` <button data-carry-all class="ghost-btn">All → today</button>` : ""}${overdue.length ? overdue.map((t) => taskRow(t, { carry: date === todayToronto() })).join("") : "<p class='muted'>Nothing overdue.</p>"}</div>
  <div class="panel"><h3>Due Today (${todos.length})</h3>${date === todayToronto() && todos.length ? `<p><button data-push-all class="ghost-btn">All → tomorrow</button></p>` : ""}${todos.length ? todos.map(taskRow).join("") : "<p class='muted'>Nothing due this day.</p>"}</div>
  ${completedDayHtml(date)}
  ${body}`;
}

function weatherIcon(code) {
  if (code === 0) return { icon: "☀️", condition: "Clear" };
  if (code === 1) return { icon: "🌤️", condition: "Mainly clear" };
  if (code === 2) return { icon: "⛅", condition: "Partly cloudy" };
  if (code === 3) return { icon: "☁️", condition: "Overcast" };
  if (code === 45 || code === 48) return { icon: "🌫️", condition: "Fog" };
  if (code >= 51 && code <= 57) return { icon: "🌦️", condition: "Drizzle" };
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return { icon: "🌧️", condition: "Rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { icon: "❄️", condition: "Snow" };
  if (code >= 95) return { icon: "⛈️", condition: "Thunderstorm" };
  return { icon: "🌡️", condition: "Unknown" };
}
// Haptics (stamp bz): a tiny tick on confirm actions; silently a
// no-op where the platform has no vibrator (desktop browsers).
function buzz() { try { navigator.vibrate?.(12); } catch { /* unsupported */ } }

const WX_CACHE_KEY = "dashben-weather";
function wxCacheSave(data) {
  try { localStorage.setItem(WX_CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* storage full/blocked */ }
}
function wxCacheLoad() {
  if (state.weather) return;
  try {
    const raw = localStorage.getItem(WX_CACHE_KEY);
    if (!raw) return;
    const { at, data } = JSON.parse(raw);
    if (data && data.current && data.daily) { state.weather = data; state.weatherStale = at || null; }
  } catch { /* ignore a bad cache */ }
}
async function fetchWeather() {
  // Weather cache + retry (stamps by + bz): the last good forecast
  // is kept in localStorage; a cold start or a failed fetch shows
  // the cached copy (flagged stale) instead of nothing, and a
  // failure retries at most once a minute until fresh data lands.
  if (state.weatherFetching) return;
  wxCacheLoad();
  if (state.weather && !state.weatherStale) return;
  if (state.weatherTriedAt && Date.now() - state.weatherTriedAt < 60000) return;
  state.weatherFetching = true;
  state.weatherTriedAt = Date.now();
  state.weatherTried = true;
  try {
    // Same request production uses (today + next 3 days).
    const url = "https://api.open-meteo.com/v1/forecast?latitude=43.4635&longitude=-81.18748&current=temperature_2m,apparent_temperature,wind_speed_10m&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset&hourly=temperature_2m,weather_code,precipitation_probability&timezone=America%2FToronto&forecast_days=4";
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    state.weather = await res.json();
    state.weatherStale = null;
    wxCacheSave(state.weather);
    queueWidgetSnapshot(); // shell: fresh weather feeds the widget snapshot
  } catch { /* keep any cached copy on screen */ }
  state.weatherFetching = false;
  if (state.tab === "dashboard" || state.tab === "daily") render();
}
function weatherPanel() {
  if (!state.weather) {
    if (state.weatherTried) { fetchWeather(); return `<div class="panel weather-panel"><h3>Weather — Mitchell, Ontario</h3><p class="muted">Weather unavailable right now — retrying automatically.</p></div>`; }
    fetchWeather();
    return `<div class="panel weather-panel"><h3>Weather — Mitchell, Ontario</h3><p class="muted">Loading…</p></div>`;
  }
  const days = state.weather.daily;
  const cards = days.time.map((date, i) => {
    const { icon, condition } = weatherIcon(days.weathercode?.[i] ?? -1);
    const label = i === 0 ? "Today" : new Intl.DateTimeFormat("en-CA", { weekday: "short", timeZone: "America/Toronto" }).format(new Date(`${date}T12:00:00Z`));
    const monthDay = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" }).format(new Date(`${date}T12:00:00Z`));
    return `<div class="weather-card${i === state.weatherDay ? " selected" : ""}" data-weather-day="${i}"><div><strong>${label}</strong></div><div class="muted">${monthDay}</div><div style="font-size:28px">${icon}</div><div class="muted">${condition}</div><div>${Math.round(days.temperature_2m_max[i])}° / ${Math.round(days.temperature_2m_min[i])}°</div><div class="muted">💧 ${days.precipitation_probability_max?.[i] ?? "?"}%</div></div>`;
  }).join("");
  const sel = state.weatherDay;
  const detail = (sel !== null && sel !== undefined && days.time[sel]) ? (() => {
    const i = sel;
    const { icon, condition } = weatherIcon(days.weathercode?.[i] ?? -1);
    const label = i === 0 ? "Today" : new Intl.DateTimeFormat("en-CA", { weekday: "long", timeZone: "America/Toronto" }).format(new Date(`${days.time[i]}T12:00:00Z`));
    const monthDay = new Intl.DateTimeFormat("en-CA", { month: "long", day: "numeric", timeZone: "America/Toronto" }).format(new Date(`${days.time[i]}T12:00:00Z`));
    const hm = (iso) => (iso ? String(iso).slice(11, 16) : "?");
    const stat = (ico, val, lab) => `<div class="wd-stat"><span class="wd-ico">${ico}</span><span class="wd-val">${val}</span><span class="wd-lab">${lab}</span></div>`;
    // Hourly breakdown in 3-hour chunks under the day detail
    // (Ben, Nov 4, 2026): average temp, mid-chunk condition icon,
    // peak rain chance; today's current chunk is highlighted.
    const hours = state.weather.hourly;
    let chunks = "";
    if (hours?.time?.length) {
      const base = i * 24;
      const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
      const nowH = i === 0 ? new Date().getHours() : -1;
      // Rolling window (stamp bu, Ben): for today the 8 chunks start
      // at the current 3-hour window and run 24h forward (spilling
      // into tomorrow) instead of covering the calendar day from
      // midnight. Other days keep their calendar-day chunks.
      const startH = i === 0 ? Math.floor(nowH / 3) * 3 : 0;
      const tiles = [];
      for (let c = 0; c < 8; c++) {
        const hs = [base + startH + c * 3, base + startH + c * 3 + 1, base + startH + c * 3 + 2];
        const temps = hs.map((k) => hours.temperature_2m?.[k]).filter((v) => v !== undefined && v !== null);
        if (!temps.length) continue;
        const avg = Math.round(temps.reduce((a, b) => a + b, 0) / temps.length);
        const pop = Math.max(...hs.map((k) => hours.precipitation_probability?.[k] ?? 0));
        const mid = weatherIcon(hours.weather_code?.[hs[1]] ?? -1);
        const isNow = i === 0 && c === 0;
        tiles.push(`<div class="wd-chunk${isNow ? " now" : ""}"><span class="wd-lab">${hourLabel((startH + c * 3) % 24)}</span><span class="wd-ico">${mid.icon}</span><span class="wd-val">${avg}°</span><span class="wd-lab">🌧️ ${pop}%</span></div>`);
      }
      if (tiles.length) chunks = `<div class="wd-chunks">${tiles.join("")}</div>`;
    }
    // Next sun event (shell only, stamp bu): a single tile showing
    // whichever of sunrise/sunset comes next, instead of two tiles
    // (the two-tile version left the stats grid one tile ragged).
    const sunStat = (() => {
      if (i === 0) {
        const now = new Date();
        const rise = days.sunrise?.[0] ? new Date(days.sunrise[0]) : null;
        const set = days.sunset?.[0] ? new Date(days.sunset[0]) : null;
        if (rise && now < rise) return stat("🌅", hm(days.sunrise[0]), "Sunrise");
        if (set && now < set) return stat("🌇", hm(days.sunset[0]), "Sunset");
        if (days.sunrise?.[1]) return stat("🌅", hm(days.sunrise[1]), "Sunrise");
      }
      return stat("🌅", hm(days.sunrise?.[i]), "Sunrise");
    })();
    return `<div class="weather-detail"><div class="wd-head"><span class="wd-icon">${icon}</span><div><strong>${label}, ${monthDay}</strong><div class="muted">${condition}</div></div><div class="wd-temps">${Math.round(days.temperature_2m_max[i])}°<span class="muted"> / ${Math.round(days.temperature_2m_min[i])}°</span></div></div><div class="wd-grid">${stat("🌡️", `${Math.round(days.temperature_2m_max[i])}°`, "High")}${stat("❄️", `${Math.round(days.temperature_2m_min[i])}°`, "Low")}${stat("🌧️", `${days.precipitation_probability_max?.[i] ?? "?"}%`, "Rain chance")}${stat("💧", `${days.precipitation_sum?.[i] ?? "?"} mm`, "Precipitation")}${stat("💨", `${days.wind_speed_10m_max?.[i] ?? "?"} km/h`, "Wind")}${sunStat}</div>${chunks}</div>`;
  })() : "";
  return `<div class="panel weather-panel"><h3>Weather — Mitchell, Ontario</h3>${state.weatherStale ? `<p class="muted">Offline copy — retrying automatically.</p>` : ""}<p class="muted">${Math.round(state.weather.current.temperature_2m)}° now</p><div class="weather-grid">${cards}</div>${detail}</div>`;
}
function dailyWorkspacePanel() {
  const today = todayToronto();
  const note = dailyNoteFor(today);
  const overdue = sortByPrio(openTasks().filter((t) => t.due_date && t.due_date < today));
  const dueToday = sortByPrio(openTasks().filter((t) => t.due_date === today));
  let inner = "";
  if (note) {
    const { schedule, notes } = splitSchedule(note.body_markdown ?? "");
    inner = `<div class="panel"><h3>Todos</h3>${overdue.length ? `<button data-carry-all class="ghost-btn">All overdue → today</button> ` : ""}${dueToday.length ? `<button data-push-all class="ghost-btn">All today → tomorrow</button> ` : ""}${overdue.length ? `<h4>Overdue (${overdue.length})</h4>${overdue.map((t) => taskRow(t, { carry: true, snooze: true })).join("")}<h4>Due today</h4>` : ""}${dueToday.length ? dueToday.map((t) => taskRow(t, { snooze: true })).join("") : "<p class='muted'>Nothing due today.</p>"}</div>
    <form data-dash-task class="form"><span class="hl-wrap"><span class="hl-back"></span><input class="hl-input" name="title" placeholder="New task" required></span>${quickProjectSelect()}<button class="primary-btn">+ New task</button><span class="parse-chips"></span></form>
    <h4>Schedule</h4>${schedule.length ? schedule.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No schedule yet.</p>"}
    <h4>Notes</h4>${notes.join("\n").trim() ? notes.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No notes yet.</p>"}
    <form data-daily-jot="${today}" class="form"><input name="jot" placeholder="Jot a note…" style="flex:1"><button>Add note</button></form>
    <p><button data-open="notes:${note.id}">Open full note</button></p>`;
  } else {
    inner = `<div class="panel"><h3>Todos</h3>${overdue.length ? `<button data-carry-all class="ghost-btn">All overdue → today</button> ` : ""}${dueToday.length ? `<button data-push-all class="ghost-btn">All today → tomorrow</button> ` : ""}${overdue.length ? `<h4>Overdue (${overdue.length})</h4>${overdue.map((t) => taskRow(t, { carry: true, snooze: true })).join("")}<h4>Due today</h4>` : ""}${dueToday.length ? dueToday.map((t) => taskRow(t, { snooze: true })).join("") : "<p class='muted'>Nothing due today.</p>"}</div>
    <form data-dash-task class="form"><span class="hl-wrap"><span class="hl-back"></span><input class="hl-input" name="title" placeholder="New task" required></span>${quickProjectSelect()}<button class="primary-btn">+ New task</button><span class="parse-chips"></span></form>
    <p class="muted">No daily note for today yet.</p><p><button data-create-daily="${today}" class="primary-btn">Create today's daily note</button></p>`;
  }
  return `<div class="panel"><h3>Daily Note</h3><p><button data-daily-tab>Open Daily tab →</button></p>${completedDayHtml(todayToronto(), true)}${inner}</div>`;
}
function upcomingPanel() {
  const today = todayToronto();
  const d = new Date(today + "T12:00:00");
  const addDays = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const tomorrow = addDays(1), weekEnd = addDays(7);
  const dueTomorrow = sortByPrio(openTasks().filter((t) => t.due_date === tomorrow));
  const dueWeek = sortByPrio(openTasks().filter((t) => t.due_date && t.due_date > tomorrow && t.due_date <= weekEnd));
  const section = (label, list) => `<h4>${label} (${list.length})</h4>${list.length ? list.map((t) => taskRow(t, { snooze: true })).join("") : "<p class='muted'>None.</p>"}`;
  const dueToday = sortByPrio(openTasks().filter((t) => t.due_date === today));
  return `<div class="panel"><h3>Upcoming</h3>
  ${section("Due Today", dueToday)}
  ${section("Due Tomorrow", dueTomorrow)}
  ${section("Due This Week", dueWeek)}</div>`;
}
function inboxPanel() {
  const items = inboxItems();
  const photoCounts = attachmentCounts("inbox_items");
  return `<div class="panel inbox-panel"><h3>Inbox (${items.length})</h3>
  ${items.map((i) => `<div class="row" data-inbox="${i.id}"><span class="row-title">${esc(i.title)}${photoInd(photoCounts, i.id)}</span><span class="muted">${esc((i.body_markdown ?? "").slice(0, 80))}</span></div>`).join("") || "<p class='muted'>Inbox empty.</p>"}
  <form data-capture class="form"><input name="title" placeholder="Title (optional)"><textarea name="body" rows="2" placeholder="Capture… a pasted link files to Reading; start with task: to make a task"></textarea><input type="file" name="photo" accept="image/*,.pdf,.txt,.md,.csv,.doc,.docx,.rtf" multiple><button class="primary-btn">+ Capture to inbox</button></form></div>`;
}

// --- Local search index (P4). search_fts is deliberately never
// synced, so the client builds its own index. NOTE: the vendored
// sql.js build has NO FTS5 module ("no such module: fts5"), so this
// is a plain token table, not a virtual FTS table. Prefix matching
// (token LIKE 'term%') keeps search forgiving without stemming.
const FTS_TABLES = ["tasks", "notes", "people", "reading_items", "projects", "inbox_items"];
function ensureSearchIndex() {
  state.db.exec(`CREATE TABLE IF NOT EXISTS search_tokens(token TEXT, object_type TEXT, object_id TEXT, title TEXT, PRIMARY KEY(token, object_type, object_id));
  CREATE INDEX IF NOT EXISTS idx_search_tokens_token ON search_tokens(token);`);
}
function tokenize(text) {
  return [...new Set(String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];
}
function rebuildSearchIndex() {
  const db = state.db;
  db.exec("DELETE FROM search_tokens;");
  const ins = db.prepare("INSERT OR IGNORE INTO search_tokens(token, object_type, object_id, title) VALUES (?, ?, ?, ?)");
  for (const t of FTS_TABLES) {
    for (const r of db.prepare(`SELECT id, title, body_markdown FROM ${t} WHERE archived=0`).all()) {
      for (const tok of tokenize(`${r.title ?? ""} ${r.body_markdown ?? ""}`)) ins.run([tok, t, r.id, r.title]);
    }
  }
  for (const r of db.prepare("SELECT id, title, fields_json FROM custom_objects WHERE archived=0").all()) {
    for (const tok of tokenize(`${r.title ?? ""} ${r.fields_json ?? ""}`)) ins.run([tok, "custom_objects", r.id, r.title]);
  }
}
function searchSnippet(table, id, terms) {
  const row = state.store.getRow(table, id);
  if (!row) return "";
  const body = row.body_markdown ?? row.fields_json ?? "";
  const hay = `${row.title ?? ""} ${body}`;
  const lower = hay.toLowerCase();
  let at = -1, term = "";
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0) { at = i; term = t; break; }
  }
  if (at < 0) return "";
  const start = Math.max(0, at - 40), end = Math.min(hay.length, at + term.length + 40);
  return `${start > 0 ? "…" : ""}${hay.slice(start, end)}${end < hay.length ? "…" : ""}`;
}
function runSearchTokens(q) {
  const terms = tokenize(q);
  if (!terms.length) return null;
  const parts = terms.map(() => "SELECT object_type, object_id, title FROM search_tokens WHERE token LIKE ?");
  const params = terms.map((t) => `${t}%`);
  const rows = state.db.prepare(parts.join(" INTERSECT ")).all(...params);
  return rows.map((r) => `<div class="row"><span class="badge">${esc(r.object_type)}</span><span class="row-title" data-open="${r.object_type}:${r.object_id}">${esc(r.title)}</span><span class="muted">${esc(searchSnippet(r.object_type, r.object_id, terms))}</span></div>`);
}

// --- Calendar tab (stamp 2026-11-04ak) ---
// Month view of the family calendar. Fetches the exact grid range
// (?from=<first cell>&days=42) through the same Worker feed as the
// dashboard panel; ranges are cached per grid start for 15 minutes.
function calState() {
  if (!state.calView) { const today = todayToronto(); state.calView = { month: today.slice(0, 7), selected: today, mode: null }; }
  return state.calView;
}
function buildCalCells(month) {
  const first = month + "-01";
  const dow = new Date(first + "T12:00:00").getDay();
  const start = ymdAdd(first, -dow);
  return Array.from({ length: 42 }, (_, i) => ymdAdd(start, i));
}
function calMonthLabel(month) {
  return new Date(month + "-01T12:00:00").toLocaleDateString("en-CA", { month: "long", year: "numeric" });
}
function calEventsByDay(events) {
  const map = new Map();
  for (const e of events) for (const d of famEventDays(e)) {
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(e);
  }
  for (const list of map.values()) list.sort((a, b) => (a.allDay === b.allDay ? (a.start < b.start ? -1 : 1) : a.allDay ? -1 : 1));
  return map;
}
function calChipTime(iso) {
  const p = {};
  for (const part of new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(new Date(iso))) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  const suffix = (p.dayPeriod || "").toLowerCase().startsWith("p") ? "p" : "a";
  return p.minute === "00" ? `${parseInt(p.hour, 10)}${suffix}` : `${parseInt(p.hour, 10)}:${p.minute}${suffix}`;
}
async function loadCalRange(force = false) {
  const view = calState();
  const key = buildCalCells(view.month)[0];
  const t = state.transport;
  if (!t || !t.base || !t.token) return;
  const cur = state.calRange;
  if (!force && cur && cur.key === key && cur.status === "ok" && Date.now() - cur.fetchedAt < 15 * 60 * 1000) return;
  if (cur?.loading) return;
  state.calRange = { key, loading: true, status: cur?.status ?? "idle", events: cur?.key === key ? cur.events : [], fetchedAt: cur?.fetchedAt ?? 0 };
  try {
    const res = await fetch(`${t.base}/api/sync/calendar?from=${key}&days=42`, { headers: { Authorization: `Bearer ${t.token}` } });
    if (res.status === 501) state.calRange = { key, status: "unconfigured", events: [], fetchedAt: 0 };
    else if (!res.ok) throw new Error(`calendar -> ${res.status}`);
    else { const data = await res.json(); state.calRange = { key, status: "ok", events: data.events ?? [], fetchedAt: Date.now() }; }
  } catch {
    state.calRange = { key, status: "error", events: state.calRange?.events ?? [], fetchedAt: state.calRange?.fetchedAt ?? 0 };
  }
  if (state.tab === "calendar" && !state.itemView) render();
}
function renderCalendar() {
  const view = calState();
  const cells = buildCalCells(view.month);
  const range = state.calRange;
  if (!range || range.key !== cells[0]) loadCalRange();
  if (range?.status === "unconfigured") {
    return `<div class="panel"><h3>Calendar</h3><p class="muted">The family calendar isn't connected yet — add the FAMILY_CAL_ICS_URL secret to the pkm-new Worker, deploy, then check again.</p><p><button data-cal-retry class="ghost-btn">Check again</button></p></div>`;
  }
  const byDay = calEventsByDay(range?.events ?? []);
  const tasksByDay = new Map();
  for (const t of allRows("tasks")) {
    if (t.archived || t.done || !t.due_date) continue;
    if (t.due_date < cells[0] || t.due_date > cells[cells.length - 1]) continue;
    if (!tasksByDay.has(t.due_date)) tasksByDay.set(t.due_date, []);
    tasksByDay.get(t.due_date).push(t);
  }
  const today = todayToronto();
  const grid = cells.map((d) => {
    const list = byDay.get(d) ?? [];
    const tlist = tasksByDay.get(d) ?? [];
    const chips = list.slice(0, 3).map((e) => `<span class="cal-chip${e.allDay ? " cal-chip-allday" : ""}">${e.allDay ? "" : esc(calChipTime(e.start)) + " "}${esc(e.title)}</span>`).join("") + tlist.slice(0, Math.max(0, 3 - list.length)).map((t) => `<span class="cal-chip cal-task" data-open="tasks:${t.id}">${esc(t.title)}</span>`).join("");
    const total = list.length + tlist.length;
    const more = total > 3 ? `<span class="cal-more">+${total - 3} more</span>` : "";
    return `<button type="button" class="cal-cell${d.slice(0, 7) !== view.month ? " cal-other" : ""}${d === today ? " cal-today" : ""}${d === view.selected ? " cal-selected" : ""}" data-cal-day="${d}"><span class="cal-dnum">${parseInt(d.slice(8), 10)}</span>${chips}${more}</button>`;
  }).join("");
  const selList = byDay.get(view.selected) ?? [];
  const dayMode = view.mode ?? (selList.length ? "events" : "tasks");
  const selTasks = tasksByDay.get(view.selected) ?? [];
  const selLabel = view.selected === today ? "Today" : new Date(view.selected + "T12:00:00").toLocaleDateString("en-CA", { weekday: "long", month: "long", day: "numeric" });
  return `<div class="panel cal-panel"><div class="cal-head"><button data-cal-nav="-1" class="ghost-btn" aria-label="Previous month">\u2039</button><h3>${esc(calMonthLabel(view.month))}</h3><button data-cal-nav="1" class="ghost-btn" aria-label="Next month">\u203a</button><button data-cal-today class="ghost-btn">Today</button></div>
  <div class="cal-week">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((w) => `<span>${w}</span>`).join("")}</div>
  <div class="cal-grid">${grid}</div>
  ${range?.status === "error" ? `<p class="muted">Couldn't load the calendar. <button data-cal-retry class="ghost-btn">Retry</button></p>` : range?.status !== "ok" ? "<p class='muted'>Loading\u2026</p>" : ""}
  </div>
  <div class="panel"><h3>${esc(selLabel)}</h3><div class="cal-mode-toggle"><button data-cal-mode="events" class="toggle-btn ${dayMode === "events" ? "active" : ""}">Events (${selList.length})</button><button data-cal-mode="tasks" class="toggle-btn ${dayMode === "tasks" ? "active" : ""}">Tasks (${selTasks.length})</button></div>${dayMode === "events" ? (selList.length ? selList.map((e) => `<div class="row"><span class="fam-time">${esc(famTimeLabel(e))}</span><span class="row-title">${esc(e.title)}</span>${e.location ? `<span class="muted">${esc(e.location)}</span>` : ""}</div>`).join("") : "<p class='muted'>No events this day.</p>") : (selTasks.length ? selTasks.map((t) => `<div class="row"><input type="checkbox" data-tick="${t.id}"><span class="row-title cal-task-link" data-open="tasks:${t.id}">${esc(t.title)}</span></div>`).join("") : "<p class='muted'>No tasks due this day.</p>")}</div>`;
}

// Management sections keep their open/closed state across renders
// (stamp de): render() rebuilds the tab on every action, so without
// this the accordion would snap shut after every tap.
const mgmtOpen = new Set(["sync"]);

function renderManagement() {
  const prefs = getTabPrefs();
  const allTags = state.db.prepare("SELECT DISTINCT tag FROM object_tags ORDER BY tag").all().map((r) => r.tag);
  const types = state.db.prepare("SELECT * FROM custom_object_types ORDER BY name").all();
  const currentTheme = state.store.getRow("ui_prefs", "theme")?.value ?? "ember";
  const themeLabel = THEMES.find(([v]) => v === currentTheme)?.[1] ?? currentTheme;
  const ungrouped = allTabIds().filter((id) => !prefs.groups.some((g) => (g.tabs ?? []).includes(id)));
  const knownTabs = allTabIds();
  const order = [...prefs.order.filter((id) => knownTabs.includes(id)), ...knownTabs.filter((id) => !prefs.order.includes(id))];
  const remindersOff = state.store.getRow("ui_prefs", "reminders")?.value === "off";
  const dbKb = state.db ? Math.round(state.db.exportBytes().length / 1024) : 0;
  const sec = (key, title, sub, body) => `<details class="mgmt-sec" data-mgmt-sec="${key}"${mgmtOpen.has(key) ? " open" : ""}><summary><span class="mgmt-title">${title}</span><span class="mgmt-state">${sub}</span><span class="mgmt-chev">\u25b8</span></summary><div class="mgmt-body">${body}</div></details>`;
  return `<h2 class="mgmt-h">Management</h2>
  ${sec("sync", "Sync", state.token ? `Connected \u00b7 ${dbKb} KB` : `No token \u00b7 ${dbKb} KB`, `
  <p class="muted">Your data syncs with pkm.ben-cloud.net. Saving a token starts a sync \u2014 delete any test items first, since later syncs upload local changes.${state.bootMs ? ` Started in ${state.bootMs} ms.` : ""}</p>
  <div class="token-card"><label for="sync-token-input">Sync token</label>
  <input id="sync-token-input" type="text" style="-webkit-text-security: disc;" autocomplete="off" data-1p-ignore="true" data-lpignore="true" placeholder="SYNC_TOKEN">
  <div class="mgmt-btnrow"><button data-token-save class="ghost-btn">Save token</button>
  <button data-full-sync class="ghost-btn">Re-download everything</button>
  <span class="muted">${state.token ? "Token saved" : "No token set"}</span></div></div>
  <div class="mgmt-row"><div class="mgmt-rowtext"><span class="mgmt-label">Health check</span><span class="muted">Compares this device with the server, table by table.</span></div><button data-health-check class="ghost-btn">Run</button></div>${state.healthHtml ?? ""}`)}
  ${sec("alerts", "Reminders & lock", `Reminders ${remindersOff ? "off" : "on"} \u00b7 Lock ${appLockOn() ? "on" : "off"}`, `
  <div class="mgmt-row"><div class="mgmt-rowtext"><span class="mgmt-label">Due reminders \u2014 <b>${remindersOff ? "Off" : "On"}</b></span><span class="muted">A 9 a.m. nudge on each due day, plus a morning digest while tasks are overdue.</span></div><button data-reminder-toggle class="ghost-btn">${remindersOff ? "Turn on" : "Turn off"}</button></div>
  <div class="mgmt-row"><div class="mgmt-rowtext"><span class="mgmt-label">App lock \u2014 <b>${appLockOn() ? "On" : "Off"}</b></span><span class="muted">Require fingerprint or device PIN to open DashBen. Locks again after a minute in the background.</span></div><button data-applock-toggle class="ghost-btn">${appLockOn() ? "Turn off" : "Turn on"}</button></div>`)}
  ${sec("appearance", "Appearance", esc(themeLabel), `
  <p class="muted">Current theme: <b>${esc(themeLabel)}</b></p>
  <div class="theme-grid">${THEMES.map(([v, label]) => `<button data-theme-btn="${v}" ${v === currentTheme ? "disabled" : ""}>${label}</button>`).join("")}</div>`)}
  ${sec("tabs", "Tabs", `${order.length} tabs \u00b7 ${prefs.groups.length} groups`, `
  <h4 class="mgmt-sub">Order</h4><p class="muted">Drag tabs to reorder them, then save.</p>
  <ul data-tab-order-list>${order.map((tid) => `<li draggable="true" data-tab-order-item="${tid}">\u2630 ${esc(tabLabel(tid))}</li>`).join("")}</ul>
  <p><button data-tab-order-save class="ghost-btn">Save order</button></p>
  <h4 class="mgmt-sub">Groups</h4>
  ${prefs.groups.map((g) => `<div class="mgmt-group"><form data-group-rename class="form inline"><input type="hidden" name="id" value="${g.id}"><input name="label" value="${esc(g.label)}"><button>Rename</button><button type="button" data-group-delete="${g.id}">Delete group</button></form>
    ${(g.tabs ?? []).map((tid) => `<p class="muted" style="margin-left:16px">${esc(tabLabel(tid))} <button data-group-remove-tab="${g.id}|${tid}">Remove</button></p>`).join("")}</div>`).join("") || "<p class='muted'>No groups yet.</p>"}
  <form data-group-create class="form inline"><input name="label" placeholder="New group name" required><button>Create group</button></form>
  <p><button data-reset-tabs class="ghost-btn">Reset tabs</button></p>
  <h4 class="mgmt-sub">Ungrouped tabs</h4>
  ${ungrouped.map((tid) => `<form data-group-add-tab class="form inline"><span>${esc(tabLabel(tid))}</span><input type="hidden" name="tab" value="${tid}"><select name="group">${prefs.groups.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join("")}</select><button ${prefs.groups.length ? "" : "disabled"}>Add to group</button></form>`).join("") || "<p class='muted'>Every tab is in a group.</p>"}`)}
  ${sec("vocab", "Vocabularies", `${MANAGED_FIELD_LIST.length} fields \u00b7 ${allTags.length} tags`, `
  <p class="muted">Selectable values for every field. Renaming a value renames it on every row using it; deleting a value that is in use is blocked.</p>
  ${MANAGED_FIELD_LIST.map(([ot, f]) => `<h4 class="mgmt-sub">${ot}.${f}</h4>
    ${vocabValues(ot, f).map((v) => `<form data-fv-rename class="form inline mgmt-vrow"><input type="hidden" name="objectType" value="${ot}"><input type="hidden" name="field" value="${f}"><input type="hidden" name="old" value="${esc(v)}"><span class="mgmt-vname">${esc(v)}</span><input name="new" value="${esc(v)}"><button type="button" class="vrow-edit ghost-btn" data-vrow-edit>Edit</button><button class="vrow-save primary-btn">Save</button><button type="button" class="vrow-cancel ghost-btn" data-vrow-cancel>Cancel</button><button type="button" class="vrow-del ghost-btn" data-fv-delete="${ot}|${f}|${esc(v)}">Delete</button></form>`).join("")}
    <form data-fv-add class="form inline mgmt-vrow"><input type="hidden" name="objectType" value="${ot}"><input type="hidden" name="field" value="${f}"><input name="value" placeholder="New value"><button>Add</button></form>`).join("")}
  <h4 class="mgmt-sub">Tags</h4><p class="muted">Renaming a tag renames it on every item using it; deleting removes it from every item using it.</p>
  ${allTags.map((t) => `<form data-tag-rename class="form inline mgmt-vrow"><input type="hidden" name="old" value="${esc(t)}"><span class="mgmt-vname">${esc(t)}</span><input name="new" value="${esc(t)}"><button type="button" class="vrow-edit ghost-btn" data-vrow-edit>Edit</button><button class="vrow-save primary-btn">Save</button><button type="button" class="vrow-cancel ghost-btn" data-vrow-cancel>Cancel</button><button type="button" class="vrow-del ghost-btn" data-tag-delete="${esc(t)}">Delete</button></form>`).join("") || "<p class='muted'>No tags yet.</p>"}${pillColorsBody()}`)}
  ${sec("templates", "Templates", `${getTemplates().length} saved`, `
  <p class="muted">Prefilled skeletons offered in the New task / New note forms. Stored in the app and synced like everything else.</p>
  ${getTemplates().map((t) => `<p class="tpl-row"><strong>${esc(t.name)}</strong> <span class="muted">${esc(t.kind)}</span> <button data-tpl-del="${t.id}" class="ghost-btn">Delete</button></p>`).join("") || "<p class='muted'>No templates yet.</p>"}
  <form data-tpl-add class="form">
    <div class="cf-row"><div class="cf-field"><label class="cf-label">Name</label><input name="name" required></div>
    <div class="cf-field"><label class="cf-label">Kind</label><select name="kind"><option value="note">Note</option><option value="task">Task</option></select></div></div>
    <div class="cf-field"><label class="cf-label">Title prefill (optional)</label><input name="title"></div>
    <div class="cf-field"><label class="cf-label">Body</label><textarea name="body" rows="4"></textarea></div>
    <button class="primary-btn">Add template</button>
  </form>`)}
  ${sec("order", "Section order", `${GROUPINGS.length} lists`, `
  <p class="muted">Drag to rearrange the section order on grouped pages, then save each list. Sections with no items right now are included, so the order is ready when they appear. \u201cNo project\u201d, \u201cNo type\u201d and friends always stay last; Daily notes stays first.</p>
  ${GROUPINGS.map((g) => { const vals = groupOrderCandidates(g); return `<h4 class="mgmt-sub">${g.label}</h4>
    <ul data-group-order-list="${g.key}">${vals.map((v) => `<li draggable="true" data-group-order-item="${esc(v)}">\u2630 ${esc(v)}</li>`).join("") || "<li class='muted'>No values yet.</li>"}</ul>
    <p><button data-group-order-save="${g.key}" class="ghost-btn">Save order</button></p>`; }).join("")}`)}
  ${sec("custom", "Custom types", `${types.length} types`, `
  ${types.map((t) => `<p>${esc(t.name)} (${esc(t.slug)}) \u2014 ${JSON.parse(t.fields_json ?? "[]").map((f) => `${esc(f.name)} (${esc(f.kind)})`).join(", ") || "no fields"} <button data-custom-tab-toggle="${t.slug}|${t.has_tab ? 0 : 1}">${t.has_tab ? "Remove tab" : "Add tab"}</button></p>`).join("") || "<p class='muted'>No custom types yet.</p>"}
  <form data-create-custom-type class="form"><input name="name" placeholder="Type name (e.g. Book)" required>
    <div data-field-rows style="display:flex;gap:8px;flex-wrap:wrap"><span class="field-row"><input name="fname" placeholder="Field name"><select name="fkind"><option>Text</option><option>Long text</option><option>Date</option><option>Number</option><option>Yes-No</option></select></span></div>
    <button type="button" data-add-field-row>Add field</button><button>Create type</button></form>`)}
  ${sec("backup", "Backup & export", "Database \u00b7 Markdown", `
  <div class="mgmt-row"><div class="mgmt-rowtext"><span class="mgmt-label">Database (.db)</span><span class="muted">A full copy of the local database \u2014 the same format the app loads. Keep it somewhere safe as offline insurance.</span></div><button data-export-db class="primary-btn">Export</button></div>
  <div class="mgmt-row"><div class="mgmt-rowtext"><span class="mgmt-label">Markdown (.zip)</span><span class="muted">Every item as a Markdown file, zipped.</span></div><button data-export-md class="primary-btn">Export</button></div>`)}`;
}

function renderCustomTab(slug) {
  const def = state.store.getRow("custom_object_types", slug);
  if (!def) return `<h2>Unknown type</h2>`;
  const fields = JSON.parse(def.fields_json ?? "[]");
  const rows = state.db.prepare("SELECT * FROM custom_objects WHERE type=? AND archived=0 ORDER BY updated_at DESC LIMIT 100").all(slug);
  const fieldInput = (f, val) => {
    if (f.kind === "Long text") return `<textarea name="f:${esc(f.name)}" placeholder="${esc(f.name)}">${esc(val ?? "")}</textarea>`;
    if (f.kind === "Date") return `<input type="date" name="f:${esc(f.name)}" value="${esc(val ?? "")}">`;
    if (f.kind === "Number") return `<input type="number" name="f:${esc(f.name)}" value="${esc(val ?? "")}">`;
    if (f.kind === "Yes-No") return `<label><input type="checkbox" name="f:${esc(f.name)}" ${val ? "checked" : ""}>${esc(f.name)}</label>`;
    return `<input name="f:${esc(f.name)}" value="${esc(val ?? "")}" placeholder="${esc(f.name)}">`;
  };
  return `<form data-create-custom="${slug}" class="form"><input name="title" placeholder="New ${esc(def.name.toLowerCase())}" required>${fields.map((f) => fieldInput(f, "")).join("")}<button>Add</button></form>
  ${rows.map((r) => {
    const vals = JSON.parse(r.fields_json ?? "{}");
    return `<div class="row" data-custom="${slug}:${r.id}"><span class="row-title">${esc(r.title)}</span>${fields.map((f) => vals[f.name] !== undefined ? `<span class="muted">${esc(f.name)}: ${esc(vals[f.name])}</span>` : "").join("")}</div>`;
  }).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
}

function customEditorHtml(slug, id, forPage) {
  const def = state.store.getRow("custom_object_types", slug);
  const row = state.store.getRow("custom_objects", id);
  if (!def || !row) return;
  const fields = JSON.parse(def.fields_json ?? "[]");
  const vals = JSON.parse(row.fields_json ?? "{}");
  const fieldInput = (f) => {
    const val = vals[f.name];
    if (f.kind === "Long text") return `<div class="cf-field"><label class="cf-label">${esc(f.name)}</label><textarea name="f:${esc(f.name)}">${esc(val ?? "")}</textarea></div>`;
    if (f.kind === "Date") return `<div class="cf-field"><label class="cf-label">${esc(f.name)}</label><input type="date" name="f:${esc(f.name)}" value="${esc(val ?? "")}"></div>`;
    if (f.kind === "Number") return `<div class="cf-field"><label class="cf-label">${esc(f.name)}</label><input type="number" name="f:${esc(f.name)}" value="${esc(val ?? "")}"></div>`;
    if (f.kind === "Yes-No") return `<div class="cf-field"><label><input type="checkbox" name="f:${esc(f.name)}" ${val ? "checked" : ""}>${esc(f.name)}</label></div>`;
    return `<div class="cf-field"><label class="cf-label">${esc(f.name)}</label><input name="f:${esc(f.name)}" value="${esc(val ?? "")}"></div>`;
  };
  return `
    <form data-edit-custom="${slug}:${id}" id="custom-form" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(row.title)}" required></div>
      ${fields.map(fieldInput).join("")}
      ${forPage ? `<button class="primary-btn">Save</button> ` : ""}<button>Close</button>
    </form>
    ${forPage ? "" : `<p><button data-archive-custom="${id}">Archive</button> </p>`}`;
}

function openCustomPopup(slug, id) {
  const __row = state.store.getRow("custom_objects", id);
  if (__row) openPopup(__row.title, customEditorHtml(slug, id, false), `custom:${slug}:${id}`);
}

function customFormFields(form, def) {
  const fields = JSON.parse(def.fields_json ?? "[]");
  const d = new FormData(form);
  const out = {};
  for (const f of fields) {
    if (f.kind === "Yes-No") out[f.name] = d.get(`f:${f.name}`) === "on";
    else if (d.get(`f:${f.name}`) !== null && d.get(`f:${f.name}`) !== "") out[f.name] = d.get(`f:${f.name}`);
  }
  return out;
}

async function appendDailyLine(date, line) {
  let note = dailyNoteFor(date);
  if (!note) note = state.store.createNote({ title: date, date });
  const body = (note.body_markdown ?? "").trim();
  await saveBody("notes", note.id, body ? `${body}\n${line}` : line);
}

function bindExtraForms() {
  const main = $("#main");
  $$("[data-daily-date]", main).forEach((el) => el.addEventListener("change", () => { state.dailyDate = el.value; render(); }));
  $$("[data-carry-all]", main).forEach((b) => b.addEventListener("click", () => { const td = todayToronto(); allRows("tasks").filter((t) => !t.archived && !t.done && t.due_date && t.due_date < td).forEach((t) => state.store.updateProps("tasks", t.id, { due_date: td })); render(); saveBytes(); }));
  $$("[data-push-all]", main).forEach((b) => b.addEventListener("click", () => { const td = todayToronto(); allRows("tasks").filter((t) => !t.archived && !t.done && t.due_date === td).forEach((t) => state.store.updateProps("tasks", t.id, { due_date: ymdAdd(td, 1) })); render(); saveBytes(); }));
  $$("[data-tpl-add]", main).forEach((f) => f.addEventListener("submit", (e) => { e.preventDefault(); const d = new FormData(f); const name = (d.get("name") || "").trim(); if (!name) return; setTemplates([...getTemplates(), { id: "tpl-" + Date.now().toString(36), kind: d.get("kind") || "note", name, title: (d.get("title") || "").trim(), body: d.get("body") || "" }]); render(); saveBytes(); }));
  $$("[data-tpl-del]", main).forEach((b) => b.addEventListener("click", () => { setTemplates(getTemplates().filter((t) => t.id !== b.dataset.tplDel)); render(); saveBytes(); }));
  $$("[data-inbox-bulk-toggle]", main).forEach((b) => b.addEventListener("click", () => { state.inboxBulk = !state.inboxBulk; if (!state.inboxBulk) state.inboxSel = new Set(); render(); }));
  $$("[data-inbox-sel]", main).forEach((c) => c.addEventListener("change", () => { const s = (state.inboxSel ??= new Set()); if (c.checked) s.add(c.dataset.inboxSel); else s.delete(c.dataset.inboxSel); render(); }));
  $$("[data-inbox-bulk-clear]", main).forEach((b) => b.addEventListener("click", () => { state.inboxSel = new Set(); render(); }));
  $$("[data-inbox-bulk-archive]", main).forEach((b) => b.addEventListener("click", () => { for (const id of [...(state.inboxSel ?? [])]) state.store.archiveObject("inbox_items", id); state.inboxSel = new Set(); state.inboxBulk = false; render(); saveBytes(); }));
  $$("[data-inbox-bulk-move]", main).forEach((b) => b.addEventListener("click", () => { for (const id of [...(state.inboxSel ?? [])]) { const item = state.store.getRow("inbox_items", id); if (!item) continue; const note = state.store.createNote({ title: item.title, body: item.body_markdown ?? "" }); state.store.reassignAttachments("inbox_items", id, "notes", note.id); state.store.archiveObject("inbox_items", id); } state.inboxSel = new Set(); state.inboxBulk = false; render(); saveBytes(); }));
  $$("[data-weather-day]", main).forEach((el) => el.addEventListener("click", () => { const i = Number(el.dataset.weatherDay); state.weatherDay = state.weatherDay === i ? null : i; render(); }));
  $$("[data-daily-jot]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = (new FormData(f).get("jot") || "").trim();
    if (!text) return;
    try { await appendDailyLine(f.dataset.dailyJot || todayToronto(), text); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-daily-schedule]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const time = d.get("time"), text = (d.get("text") || "").trim();
    if (!time || !text) return;
    try { await appendDailyLine(f.dataset.dailySchedule, `${time} — ${text}`); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-dash-task]", main).forEach((f) => { wireSmartInput(f); f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = (new FormData(f).get("title") || "").trim();
    if (!title) return;
    // Smart quick-add (stamp 2026-11-04w): a due date / priority in
    // the text ("Pay rent Fri P1") is parsed out of the title.
    const parsed = parseQuickTaskRich(title, f._suppress);
    state.store.createTask({ title: parsed.title, due: parsed.due ?? todayToronto(), priority: parsed.priority, project: (new FormData(f).get("project") || "General") });
    render(); saveBytes();
    // Rapid entry (stamp 2026-11-04l): render() rebuilt the dashboard,
    // so put the cursor straight back in the new quick-add box — Enter,
    // type, Enter chains without touching the mouse.
    document.querySelector("[data-dash-task] input[name=title]")?.focus();
  }); });
  $$("[data-daily-nav]", main).forEach((f) => f.addEventListener("submit", (e) => e.preventDefault()));
  $$("[data-fv-add]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    try { state.store.addFieldValue(d.get("objectType"), d.get("field"), d.get("value")); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-fv-rename]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    try { state.store.renameFieldValue(d.get("objectType"), d.get("field"), d.get("old"), d.get("new")); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-tag-rename]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    try { state.store.renameTag(d.get("old"), d.get("new")); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-group-create]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = new FormData(f).get("label").trim();
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const p = getTabPrefs();
    if (!p.groups.some((g) => g.id === id)) p.groups.push({ id, label, tabs: [], collapsed: false });
    state.store.setTabPrefs(p);
    render(); saveBytes();
  }));
  $$("[data-group-rename]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const p = getTabPrefs();
    const g = p.groups.find((x) => x.id === d.get("id"));
    if (g) { g.label = d.get("label"); state.store.setTabPrefs(p); }
    render(); saveBytes();
  }));
  $$("[data-group-add-tab]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const p = getTabPrefs();
    for (const g of p.groups) g.tabs = (g.tabs ?? []).filter((t) => t !== d.get("tab"));
    const g = p.groups.find((x) => x.id === d.get("group"));
    if (g && !g.tabs.includes(d.get("tab"))) g.tabs.push(d.get("tab"));
    state.store.setTabPrefs(p);
    render(); saveBytes();
  }));
  $$("[data-add-field-row]", main).forEach((btn) => btn.addEventListener("click", () => {
    const wrap = btn.closest("form").querySelector("[data-field-rows]");
    const span = document.createElement("span");
    span.className = "field-row";
    span.innerHTML = `<input name="fname" placeholder="Field name"><select name="fkind"><option>Text</option><option>Long text</option><option>Date</option><option>Number</option><option>Yes-No</option></select>`;
    wrap.appendChild(span);
  }));
  $$("[data-group-order-list]", main).forEach((list) => {
    let dragEl = null;
    list.addEventListener("dragstart", (e) => {
      const item = e.target.closest("[data-group-order-item]");
      if (!item) return;
      dragEl = item;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", item.dataset.groupOrderItem); } catch {}
    });
    list.addEventListener("dragover", (e) => {
      const item = e.target.closest("[data-group-order-item]");
      if (!item || item === dragEl) return;
      e.preventDefault();
      item.classList.add("drag-over");
    });
    list.addEventListener("dragleave", (e) => {
      const item = e.target.closest("[data-group-order-item]");
      if (item) item.classList.remove("drag-over");
    });
    list.addEventListener("drop", (e) => {
      e.preventDefault();
      const item = e.target.closest("[data-group-order-item]");
      if (dragEl && item && item !== dragEl) {
        const r = item.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) item.before(dragEl);
        else item.after(dragEl);
      } else if (dragEl && !item) {
        list.appendChild(dragEl);
      }
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      dragEl = null;
    });
    list.addEventListener("dragend", () => {
      list.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      dragEl = null;
    });
  });
  const orderList = $("[data-tab-order-list]", main);
  if (orderList) {
    let dragId = null;
    orderList.addEventListener("dragstart", (e) => {
      const item = e.target.closest("[data-tab-order-item]");
      if (!item) return;
      dragId = item.dataset.tabOrderItem;
      e.dataTransfer.effectAllowed = "move";
      try { e.dataTransfer.setData("text/plain", dragId); } catch {}
    });
    orderList.addEventListener("dragover", (e) => {
      const item = e.target.closest("[data-tab-order-item]");
      if (!item || item.dataset.tabOrderItem === dragId) return;
      e.preventDefault();
      item.classList.add("drag-over");
    });
    orderList.addEventListener("dragleave", (e) => {
      const item = e.target.closest("[data-tab-order-item]");
      if (item) item.classList.remove("drag-over");
    });
    orderList.addEventListener("drop", (e) => {
      e.preventDefault();
      const item = e.target.closest("[data-tab-order-item]");
      const dragged = orderList.querySelector(`[data-tab-order-item="${dragId}"]`);
      if (dragged && item && item !== dragged) {
        const r = item.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) item.before(dragged);
        else item.after(dragged);
      } else if (dragged && !item) {
        orderList.appendChild(dragged);
      }
      orderList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      dragId = null;
    });
    orderList.addEventListener("dragend", () => {
      orderList.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
      dragId = null;
    });
  }
  $$("[data-create-custom-type]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const fields = [];
    const names = d.getAll("fname"), kinds = d.getAll("fkind");
    names.forEach((n, i) => { if (n.trim()) fields.push({ name: n.trim(), kind: kinds[i] }); });
    try { state.store.createCustomType({ name: d.get("name"), fields }); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
  $$("[data-create-custom]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const slug = f.dataset.createCustom;
    const def = state.store.getRow("custom_object_types", slug);
    try { state.store.createCustomObject({ type: slug, title: new FormData(f).get("title"), fields: customFormFields(f, def) }); } catch (err) { alert(err.message); return; }
    render(); saveBytes();
  }));
}

let comboDocBound = false;
function bindCreateWidgets(root = $("#popup-root")) {
  $$("[data-combo]", root).forEach((combo) => {
    if (combo.dataset.bound) return; combo.dataset.bound = "1";
    const input = combo.querySelector("[data-combo-input]");
    const hidden = combo.querySelector("[data-combo-value]");
    const list = combo.querySelector("[data-combo-list]");
    const buttons = [...combo.querySelectorAll("[data-combo-id]")];
    const emptyMsg = combo.querySelector("[data-combo-empty]");
    const titleFor = (id) => { const btn = buttons.find((x) => x.dataset.comboId === id); return btn ? btn.dataset.comboTitle : ""; };
    const filter = () => { const q = (input.value || "").toLowerCase(); let visible = 0; buttons.forEach((btn) => { const m = (btn.dataset.comboTitle || "").toLowerCase().includes(q); btn.style.display = m ? "" : "none"; if (m) visible++; }); if (emptyMsg) emptyMsg.hidden = visible > 0; };
    const show = () => { filter(); list.hidden = false; };
    const hide = () => { list.hidden = true; };
    input.addEventListener("focus", show);
    input.addEventListener("input", () => { if (input.value === "") hidden.value = ""; show(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hide(); return; }
      if (e.key === "Enter" && !list.hidden) { const first = buttons.find((btn) => btn.style.display !== "none"); if (first) { e.preventDefault(); hidden.value = first.dataset.comboId || ""; input.value = first.dataset.comboTitle || ""; hide(); } }
    });
    input.addEventListener("blur", () => setTimeout(() => {
      const q = (input.value || "").trim().toLowerCase();
      if (q === "") { hidden.value = ""; input.value = ""; return; }
      const exact = buttons.find((btn) => (btn.dataset.comboTitle || "").toLowerCase() === q);
      if (exact) { hidden.value = exact.dataset.comboId || ""; input.value = exact.dataset.comboTitle || ""; }
      else input.value = titleFor(hidden.value);
    }, 150));
    buttons.forEach((btn) => btn.addEventListener("click", () => { hidden.value = btn.dataset.comboId || ""; input.value = btn.dataset.comboTitle || ""; hide(); }));
  });
  $$("[data-tag-input]", root).forEach((tagRoot) => {
    if (tagRoot.dataset.bound) return; tagRoot.dataset.bound = "1";
    const chipsEl = tagRoot.querySelector("[data-tag-chips]");
    const text = tagRoot.querySelector("[data-tag-text]");
    const hidden = tagRoot.querySelector("[data-tag-value]");
    const list = tagRoot.querySelector("[data-tag-list]");
    const optionBtns = [...tagRoot.querySelectorAll("[data-tag-option]")];
    const createBtn = tagRoot.querySelector("[data-tag-create]");
    const createName = tagRoot.querySelector("[data-tag-create-name]");
    const emptyMsg = tagRoot.querySelector("[data-tag-empty]");
    let selected = (hidden.value || "").split(",").map((t) => t.trim()).filter(Boolean);
    const lower = (str) => str.toLowerCase();
    const renderChips = () => {
      chipsEl.innerHTML = "";
      selected.forEach((t) => {
        const chip = document.createElement("span");
        chip.className = "cf-chip"; chip.textContent = t + " ";
        const rm = document.createElement("button"); rm.type = "button"; rm.textContent = "×"; rm.setAttribute("aria-label", "Remove tag " + t);
        rm.addEventListener("click", () => { selected = selected.filter((x) => x !== t); renderChips(); });
        chip.appendChild(rm); chipsEl.appendChild(chip);
      });
      hidden.value = selected.join(", ");
    };
    renderChips();
    const filter = () => {
      const q = (text.value || "").trim().toLowerCase();
      let visible = 0;
      optionBtns.forEach((btn) => { const name = btn.dataset.tagOption || ""; const already = selected.some((x) => lower(x) === lower(name)); const match = !already && lower(name).includes(q); btn.style.display = match ? "" : "none"; if (match) visible++; });
      const exactExisting = optionBtns.some((btn) => lower(btn.dataset.tagOption || "") === q);
      const alreadySel = selected.some((x) => lower(x) === q);
      const showCreate = q !== "" && !exactExisting && !alreadySel;
      if (createBtn) { createBtn.hidden = !showCreate; if (createName) createName.textContent = (text.value || "").trim(); }
      if (emptyMsg) emptyMsg.hidden = !(q !== "" && visible === 0 && !showCreate);
    };
    const show = () => { filter(); list.hidden = false; };
    const hide = () => { list.hidden = true; };
    const add = (tag) => { tag = (tag || "").trim(); if (!tag || selected.some((x) => lower(x) === lower(tag))) return; selected.push(tag); renderChips(); text.value = ""; filter(); text.focus(); };
    text.addEventListener("focus", show);
    text.addEventListener("input", show);
    text.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { hide(); return; }
      if (e.key === "Backspace" && text.value === "" && selected.length > 0) { selected.pop(); renderChips(); return; }
      if (e.key === ",") { e.preventDefault(); add(text.value.replace(/,/g, "")); return; }
      if (e.key === "Enter" && !list.hidden) { const first = optionBtns.find((btn) => btn.style.display !== "none"); if (first) { e.preventDefault(); add(first.dataset.tagOption); return; } if (createBtn && !createBtn.hidden) { e.preventDefault(); add(text.value); } }
    });
    text.addEventListener("blur", () => setTimeout(hide, 150));
    optionBtns.forEach((btn) => btn.addEventListener("click", () => add(btn.dataset.tagOption)));
    if (createBtn) createBtn.addEventListener("click", () => add(text.value));
  });
  if (!comboDocBound) {
    comboDocBound = true;
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t.closest || (!t.closest("[data-combo]") && !t.closest("[data-tag-input]"))) {
        document.querySelectorAll("[data-combo-list],[data-tag-list]").forEach((l) => { l.hidden = true; });
      }
    });
  }
}

function bindExtraPopupForms(root = $("#popup-root")) {
  bindCreateWidgets(root);
  const root0 = root;
  $$("[data-create-task-popup]", root0).forEach((f) => {
    const freq = f.querySelector("[name=freq]");
    freq.addEventListener("change", () => { f.querySelector("[data-weekdays]").hidden = freq.value !== "weekly"; });
    const proj = f.querySelector("[name=project]");
    proj.addEventListener("change", () => { f.querySelector("[name=projectNew]").hidden = proj.value !== "__new__"; });
    const tpT = f.querySelector("[data-template-pick]");
    tpT?.addEventListener("change", () => applyTemplateToForm(f, tpT.value));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      let recurrence = null;
      if (d.get("freq")) recurrence = { freq: d.get("freq"), interval: Number(d.get("interval") || 1), weekdays: d.getAll("wd").map(Number), endDate: d.get("end") || null, dayOfMonth: null };
      const project = d.get("project") === "__new__" ? (d.get("projectNew") || "").trim() : (d.get("project") || null);
      const task = state.store.createTask({ title: d.get("title"), due: d.get("due") || null, priority: d.get("priority") || null, project: project || null, body: d.get("body") || "", recurrence });
      if (d.get("parentId")) state.store.setTaskParent(task.id, d.get("parentId"));
      if (project && !vocabValues("tasks", "project").includes(project)) state.store.addFieldValue("tasks", "project", project);
      closePopup(); render(); saveBytes();
    });
  });
  $$("[data-create-note-popup]", root).forEach((f) => {
    const typeSel = f.querySelector("[name=type]");
    typeSel.addEventListener("change", () => { f.querySelector("[name=typeNew]").hidden = typeSel.value !== "__new__"; });
    const tpN = f.querySelector("[data-template-pick]");
    tpN?.addEventListener("change", () => applyTemplateToForm(f, tpN.value));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      const type = d.get("type") === "__new__" ? (d.get("typeNew") || "").trim() || "General Notes" : (d.get("type") || "General Notes");
      const note = state.store.createNote({ title: d.get("title"), date: d.get("date") || null, type, body: d.get("body") || "" });
      const tags = (d.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean);
      if (tags.length) state.store.setTags("notes", note.id, tags);
      if (type && !vocabValues("notes", "type").includes(type)) state.store.addFieldValue("notes", "type", type);
      closePopup(); render(); saveBytes();
    });
  });
  $$("[data-create-person-popup]", root).forEach((f) => {
    const roleSel = f.querySelector("[name=role]");
    if (roleSel) roleSel.addEventListener("change", () => { f.querySelector("[name=roleNew]").hidden = roleSel.value !== "__new__"; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      const role = d.get("role") === "__new__" ? ((d.get("roleNew") || "").trim() || null) : (d.get("role") || null);
      state.store.createPerson({ title: d.get("title"), role });
      if (role && !vocabValues("people", "role").includes(role)) state.store.addFieldValue("people", "role", role);
      closePopup(); render(); saveBytes();
    });
  });
  $$("[data-create-reading-popup]", root).forEach((f) => bindLinkTitle(f));
  $$("[data-create-reading-popup]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    const item = state.store.createReading({ title: d.get("title"), url: d.get("url") });
    if (d.get("status")) state.store.updateProps("reading_items", item.id, { status: d.get("status") });
    closePopup(); render(); saveBytes();
  }));
  $$("[data-create-project-popup]", root).forEach((f) => {
    const cat = f.querySelector("[name=category]");
    cat.addEventListener("change", () => { f.querySelector("[name=categoryNew]").hidden = cat.value !== "__new__"; });
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = new FormData(f);
      const category = d.get("category") === "__new__" ? (d.get("categoryNew") || "").trim() : (d.get("category") || null);
      state.store.createProject({ title: d.get("title"), category: category || null, status: d.get("status") || null, body: d.get("body") || "" });
      if (category && !vocabValues("projects", "category").includes(category)) state.store.addFieldValue("projects", "category", category);
      closePopup(); render(); saveBytes();
    });
  });
  $$("[data-edit-custom]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const [slug, id] = f.dataset.editCustom.split(":");
    const def = state.store.getRow("custom_object_types", slug);
    try { state.store.updateCustomObject(id, { title: new FormData(f).get("title"), fields: customFormFields(f, def) }); } catch (err) { alert(err.message); return; }
    closePopup(); render(); saveBytes();
  }));
}

function attachExtraListeners() {
  const mainEl = $("#main");
  if (!mainEl.dataset.mgmtBound) {
    mainEl.dataset.mgmtBound = "1";
    mainEl.addEventListener("click", (e) => {
      const ed = e.target.closest("[data-vrow-edit]");
      if (ed) { const row = ed.closest(".mgmt-vrow"); row?.classList.add("editing"); row?.querySelector("[name=new]")?.focus(); return; }
      const cx = e.target.closest("[data-vrow-cancel]");
      if (cx) { const row = cx.closest(".mgmt-vrow"); if (row) { row.classList.remove("editing"); const inp = row.querySelector("[name=new]"); const old = row.querySelector("[name=old]"); if (inp && old) inp.value = old.value; } }
    });
    mainEl.addEventListener("toggle", (e) => {
      const d = e.target?.closest?.("[data-mgmt-sec]");
      if (!d) return;
      if (d.open) mgmtOpen.add(d.dataset.mgmtSec); else mgmtOpen.delete(d.dataset.mgmtSec);
    }, true);
  }
  $("#main").addEventListener("click", async (e) => {
    const showDone = e.target.closest("[data-show-done]");
    if (showDone) { const d = showDone.dataset.showDone; state.showDoneDay = state.showDoneDay === d ? null : d; render(); return; }
    const sendT = e.target.closest("[data-send-tony]");
    if (sendT) { doSendTony(sendT.dataset.sendTony); return; }
    const shareT = e.target.closest("[data-share-tony]");
    if (shareT) { doShareTony(shareT.dataset.shareTony); return; }
    const feedSave = e.target.closest("[data-feed-save]");
    if (feedSave) { const it = feedSeed().items[Number(feedSave.dataset.feedSave)]; if (it) { state.store.createReading({ title: it.title, url: it.link }); state.searchDirty = true; showToast("Saved to Reading"); render(); saveBytes(); } return; }
    const feedOpen = e.target.closest("[data-feed-open]");
    if (feedOpen) { const it = feedSeed().items[Number(feedOpen.dataset.feedOpen)]; if (it && !feedSeenSet().has(it.link)) { feedSeenSet().add(it.link); persistFeedSeen(); updateFeedBadge(); } }
    const feedCat = e.target.closest("[data-feed-cat]");
    if (feedCat) { feedSeed().category = feedCat.dataset.feedCat; render(); return; }
    if (e.target.closest("[data-feed-refresh]")) { loadFeed(true); return; }
    if (e.target.closest("[data-feed-sources]")) { openFeedSources(); return; }
    const pageBack = e.target.closest("[data-page-back]");
    if (pageBack) { state.itemView = null; render(); return; }
    const fullSync = e.target.closest("[data-full-sync]");
    if (fullSync) { await doFullSync(); return; }
    const healthBtn = e.target.closest("[data-health-check]");
    if (healthBtn) { healthBtn.disabled = true; healthBtn.textContent = "Checking\u2026"; await runHealthCheck(); return; }
    const exportBtn = e.target.closest("[data-export-db]");
    if (exportBtn) { await exportDb(); return; }
    const exportMdBtn = e.target.closest("[data-export-md]");
    if (exportMdBtn) { exportMarkdown(); return; }
    const tokSave = e.target.closest("[data-token-save]");
    if (tokSave) {
      const card = tokSave.closest(".token-card");
      const input = card ? card.querySelector("input") : null;
      const value = (input ? input.value : "").trim();
      if (!value) return;
      try {
        if (NativeSS) await withTimeout(NativeSS.set({ key: "sync-token", value }), 5000, "ss.set");
        else { const ls = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}"); ls.token = value; localStorage.setItem("pkm-local-settings", JSON.stringify(ls)); }
        state.token = value;
        if (state.transport) state.transport.token = value;
        // Stamp cw: a token saved onto an EMPTY app pulls the full
        // snapshot (incremental sync can never deliver rows that
        // predate the change log); otherwise a normal sync is fine.
        const emptyLocal = (() => { try { return ["tasks", "notes", "people", "reading_items", "inbox_items", "projects"].every((t) => (allRows(t) ?? []).length === 0); } catch { return false; } })();
        if (emptyLocal) await doFullSync(); else await doSync();
        if (!state.lastError) state.needsToken = false;
      } catch { /* save/sync failure shows via status line + header on next render */ }
      render(); saveBytes();
      return;
    }
    const remToggle = e.target.closest("[data-reminder-toggle]");
    if (remToggle) {
      const turnOn = state.store.getRow("ui_prefs", "reminders")?.value === "off";
      setRemindersPref(turnOn);
      if (turnOn) {
        try {
          const perm = await withTimeout(NativeNotify.checkPermissions(), 5000, "notify.check").catch(() => null);
          if (perm && perm.display !== "granted") await withTimeout(NativeNotify.requestPermissions(), 8000, "notify.request").catch(() => null);
        } catch { /* best-effort */ }
        await scheduleReminders();
      } else {
        await cancelAllReminders();
      }
      render(); saveBytes();
      return;
    }
    const lockToggle = e.target.closest("[data-applock-toggle]");
    if (lockToggle) {
      if (appLockOn()) { setAppLock(false); render(); }
      else if (NativeLock) {
        try {
          const avail = await withTimeout(NativeLock.isAvailable({}), 5000, "lock.avail").catch(() => null);
          if (!avail?.available) { lockToggle.textContent = "No fingerprint/PIN set up on this phone"; return; }
          const r = await withTimeout(NativeLock.authenticate({}), 120000, "lock.auth").catch(() => null);
          if (r?.ok) setAppLock(true);
        } catch { /* best-effort */ }
        render();
      }
      return;
    }
    const pageEdit = e.target.closest("[data-page-edit]");
    if (pageEdit) {
      const v = parsePageRef(pageEdit.dataset.pageEdit);
      if (v.type === "custom") openCustomPopup(v.slug, v.id);
      else openPopupByRef(v.type, v.id);
      return;
    }
    const pageOpen = e.target.closest("[data-open-page]");
    if (pageOpen) { openPageRef(pageOpen.dataset.openPage); return; }
    const pageArch = e.target.closest("[data-page-archive]");
    if (pageArch) {
      const v = parsePageRef(pageArch.dataset.pageArchive);
      archiveWithUndo(v.type === "custom" ? "custom_objects" : v.type, v.id);
      state.itemView = null; render(); saveBytes(); return;
    }
    const pageMove = e.target.closest("[data-page-move]");
    if (pageMove) {
      const item = state.store.getRow("inbox_items", pageMove.dataset.pageMove);
      if (item) { openMoveCategoryPrompt(item, "page"); return; }
      state.itemView = null; render(); return;
    }
    const newPersonBtn = e.target.closest("[data-new-person]");
    if (newPersonBtn) { openPersonCreatePopup(); return; }
    const newReadingBtn = e.target.closest("[data-new-reading]");
    if (newReadingBtn) { openReadingCreatePopup(); return; }
    const newProjectBtn = e.target.closest("[data-new-project]");
    if (newProjectBtn) { openProjectCreatePopup(); return; }
    const newNoteBtn = e.target.closest("[data-new-note]");
    if (newNoteBtn) { openNoteCreatePopup(); return; }
    const newTaskBtn = e.target.closest("[data-new-task]");
    if (newTaskBtn) { openTaskCreatePopup(); return; }
    const bulkToggle = e.target.closest("[data-bulk-toggle]");
    if (bulkToggle) { state.bulkMode = !state.bulkMode; if (!state.bulkMode) state.bulkSelected = new Set(); render(); return; }
    const bulkSel = e.target.closest("[data-bulk-select]");
    if (bulkSel) {
      state.bulkSelected = state.bulkSelected || new Set();
      if (bulkSel.checked) state.bulkSelected.add(bulkSel.dataset.bulkSelect); else state.bulkSelected.delete(bulkSel.dataset.bulkSelect);
      render();
      return;
    }
    const bulkAct = e.target.closest("[data-bulk-action]");
    if (bulkAct) {
      const action = bulkAct.dataset.bulkAction;
      const today = todayToronto();
      for (const id of [...(state.bulkSelected ?? [])]) {
        try {
          if (action === "complete") state.store.completeTask(id, today);
          else if (action === "archive") state.store.archiveObject("tasks", id);
          else if (action === "postpone") {
            const t = state.store.getRow("tasks", id);
            if (t) {
              const baseStr = t.due_date && t.due_date > today ? t.due_date : today;
              const d = new Date(baseStr + "T12:00:00");
              d.setDate(d.getDate() + 1);
              state.store.updateProps("tasks", id, { due_date: d.toISOString().slice(0, 10) });
            }
          }
        } catch {}
      }
      state.bulkSelected = new Set();
      if (action !== "clear") state.bulkMode = false;
      render(); saveBytes();
      return;
    }
    const filterBtn = e.target.closest("[data-tasks-filter]");
    if (filterBtn) { state.tasksFilter = filterBtn.dataset.tasksFilter; render(); return; }
    const dailyGo = e.target.closest("[data-daily-go]");
    if (dailyGo) {
      const input = dailyGo.closest("form")?.querySelector("[data-daily-date]");
      if (input?.value) { state.dailyDate = input.value; render(); }
      return;
    }
    const dailyTabBtn = e.target.closest("[data-daily-tab]");
    if (dailyTabBtn) { state.tab = "daily"; saveTab(); render(); return; }
    const groupOrderSave = e.target.closest("[data-group-order-save]");
    if (groupOrderSave) {
      const key = groupOrderSave.dataset.groupOrderSave;
      const list = document.querySelector(`[data-group-order-list="${key}"]`);
      const order = list ? [...list.querySelectorAll("[data-group-order-item]")].map((el) => el.dataset.groupOrderItem) : [];
      state.store.setGroupOrder(key, order);
      render(); saveBytes();
      return;
    }
    const tabOrderSave = e.target.closest("[data-tab-order-save]");
    if (tabOrderSave) {
      const order = $$("[data-tab-order-item]").map((el) => el.dataset.tabOrderItem);
      const prefs = getTabPrefs();
      prefs.order = order;
      state.store.setTabPrefs(prefs);
      await saveBytes(true);
      location.reload();
      return;
    }
    const confDismiss = e.target.closest("[data-conflict-dismiss]");
    if (confDismiss) {
      state.db.prepare("DELETE FROM sync_conflicts WHERE id=?").run([confDismiss.dataset.conflictDismiss]);
      render(); saveBytes();
      return;
    }
    const resetTabs = e.target.closest("[data-reset-tabs]");
    if (resetTabs) {
      state.store.setTabPrefs({ order: [...DEFAULT_TABS], hidden: [], rearrangeEnabled: true, groups: [] });
      render(); saveBytes();
      return;
    }
    const shift = e.target.closest("[data-daily-shift]");
    if (shift) {
      const cur = state.dailyDate || todayToronto();
      const d = new Date(cur + "T12:00:00");
      if (shift.dataset.dailyShift === "0") state.dailyDate = todayToronto();
      else { d.setDate(d.getDate() + Number(shift.dataset.dailyShift)); state.dailyDate = d.toISOString().slice(0, 10); }
      render();
      return;
    }
    const snoozeBtn = e.target.closest("[data-snooze-days]");
    if (snoozeBtn) {
      const t = state.store.getRow("tasks", snoozeBtn.dataset.snoozeTask);
      if (t) {
        const today = todayToronto();
        const baseStr = t.due_date && t.due_date > today ? t.due_date : today;
        const d = new Date(baseStr + "T12:00:00");
        d.setDate(d.getDate() + parseInt(snoozeBtn.dataset.snoozeDays, 10));
        state.store.updateProps("tasks", t.id, { due_date: d.toISOString().slice(0, 10) });
      }
      render(); saveBytes();
      return;
    }
    const snoozeMon = e.target.closest("[data-snooze-mon]");
    if (snoozeMon) {
      const t = state.store.getRow("tasks", snoozeMon.dataset.snoozeTask);
      if (t) {
        const today = todayToronto();
        const baseStr = t.due_date && t.due_date > today ? t.due_date : today;
        const d = new Date(baseStr + "T12:00:00");
        let delta = (8 - d.getDay()) % 7; if (delta === 0) delta = 7;
        d.setDate(d.getDate() + delta);
        state.store.updateProps("tasks", t.id, { due_date: d.toISOString().slice(0, 10) });
      }
      render(); saveBytes();
      return;
    }
    const carryToday = e.target.closest("[data-carry-today]");
    if (carryToday) {
      state.store.updateProps("tasks", carryToday.dataset.carryToday, { due_date: todayToronto() });
      render(); saveBytes();
      return;
    }
    const createDaily = e.target.closest("[data-create-daily]");
    if (createDaily) {
      const date = createDaily.dataset.createDaily;
      state.store.createNote({ title: date, date });
      render(); saveBytes();
      return;
    }
    const fvDel = e.target.closest("[data-fv-delete]");
    if (fvDel) {
      const [ot, f, v] = fvDel.dataset.fvDelete.split("|");
      try { state.store.deleteFieldValue(ot, f, v); } catch (err) { alert(err.message); return; }
      render(); saveBytes();
      return;
    }
    const tagDel = e.target.closest("[data-tag-delete]");
    if (tagDel) {
      try { state.store.deleteTag(tagDel.dataset.tagDelete); } catch (err) { alert(err.message); return; }
      render(); saveBytes();
      return;
    }
    const themeBtn = e.target.closest("[data-theme-btn]");
    if (themeBtn) {
      state.store.setTheme(themeBtn.dataset.themeBtn);
      applyTheme();
      render(); saveBytes();
      return;
    }
    const pillReset = e.target.closest("[data-pill-reset]");
    if (pillReset) {
      const v = pillReset.dataset.pillReset; const i = v.indexOf("|");
      setPillColor(v.slice(0, i), v.slice(i + 1), null);
      render(); saveBytes();
      return;
    }
    const gDel = e.target.closest("[data-group-delete]");
    if (gDel) {
      const p = getTabPrefs();
      p.groups = p.groups.filter((g) => g.id !== gDel.dataset.groupDelete);
      state.store.setTabPrefs(p);
      render(); saveBytes();
      return;
    }
    const gRem = e.target.closest("[data-group-remove-tab]");
    if (gRem) {
      const [gid, tid] = gRem.dataset.groupRemoveTab.split("|");
      const p = getTabPrefs();
      const g = p.groups.find((x) => x.id === gid);
      if (g) { g.tabs = (g.tabs ?? []).filter((t) => t !== tid); state.store.setTabPrefs(p); }
      render(); saveBytes();
      return;
    }
    const tabToggle = e.target.closest("[data-custom-tab-toggle]");
    if (tabToggle) {
      const [slug, has] = tabToggle.dataset.customTabToggle.split("|");
      state.store.setCustomTab(slug, has === "1");
      render(); saveBytes();
      return;
    }
    const customRow = e.target.closest("[data-custom]");
    if (customRow) {
      const [slug, id] = customRow.dataset.custom.split(":");
      openCustomPopup(slug, id);
      return;
    }
  });
  $("#popup-root").addEventListener("click", async (e) => {
    const arch = e.target.closest("[data-archive-custom]");
    if (arch) {
      archiveWithUndo("custom_objects", arch.dataset.archiveCustom);
      closePopup(); render(); saveBytes();
      return;
    }
  });
}
