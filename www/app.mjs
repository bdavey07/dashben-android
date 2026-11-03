// PKM client (live only) on sql.js + SyncEngine + LocalStore. It
// syncs against the real Worker; the token lives only in this
// browser's localStorage (from earlier setup) and is never sent
// anywhere except the sync host.
import { SqlJsDb } from "./db-adapter.mjs";
import { SyncEngine } from "./sync-engine.mjs";
import { LocalStore, recurrenceSummary, parseRecurrence } from "./local-store.mjs";
import { HttpTransport } from "./transport.mjs";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
  try { return Cap ? Cap.registerPlugin(name) : null; } catch { return null; }
}
const NativeFS = safePlugin("Filesystem");
const NativeSS = safePlugin("SecureStoragePlugin");
const NativeShare = safePlugin("ShareIntent");
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

const SCHEMA_URL = "./schema.sql";
const state = {
  db: null, engine: null, store: null, transport: null,
  base: "https://pkm.ben-cloud.net", token: "",
  tab: "dashboard", dailyDate: null, weather: null, weatherTried: false, itemView: null,
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
async function saveBytes() {
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
async function doSync() {
  if (state.syncing) return;
  state.syncing = true;
  const btn = $("#sync-btn");
  btn.disabled = true;
  btn.textContent = "Syncing…";
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
  btn.textContent = "Sync now";
  render();
  saveBytes();
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

// Shell: collect one pending share-sheet send (if any) into the
// inbox. The native side clears after one read, so repeated calls
// are safe — boot + every return to the foreground.
async function captureSharedText() {
  if (!NativeShare || !state.store) return;
  try {
    const r = await withTimeout(NativeShare.getSharedText(), 5000, "share.get");
    const text = (r && r.text ? String(r.text) : "").trim();
    if (!text) return;
    state.store.captureInbox({ title: "", body: text });
    render();
    saveBytes();
  } catch { /* no share pending */ }
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
  return state.db.prepare("SELECT * FROM tasks WHERE archived=0 AND done=0 ORDER BY (due_date IS NULL), due_date, title").all();
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
  $("#popup-root").innerHTML = `<div class="popup-backdrop">
    <div class="popup-card" role="dialog" aria-label="${esc(title)}">
      <div class="popup-head"><h3>${esc(title)}</h3><div class="popup-head-actions">${openRef ? `<button data-open-page="${openRef}">Open</button>` : ""}<button data-close-popup>Close</button></div></div>
      ${inner}
    </div>
  </div>`;
  bindPopupForms();
  bindExtraPopupForms();
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
function bodyFieldHtml(table, id, body, version) {
  return `<textarea name="body" rows="5">${esc(body ?? "")}</textarea><span class="muted"> v${version}</span>`;
}
function subtaskBlock(table, id, subtasksJson) {
  let subs = [];
  try { subs = JSON.parse(subtasksJson ?? "[]"); } catch { subs = []; }
  return `<h4>Subtasks</h4>
    <div data-sub-list>
      ${subs.map((s) => `<div class="row" data-sub-row="${s.id}"><input type="checkbox" ${s.done ? "checked" : ""}><span data-sub-text>${esc(s.text)}</span></div>`).join("") || "<p class='muted'>No subtasks.</p>"}
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
  return `<h4>Repeats</h4>
    <div class="cf-box">
      <div class="cf-row">
        <div class="cf-field"><label class="cf-label">Frequency</label><select name="freq"><option value="">No repeat</option><option value="daily" ${freq === "daily" ? "selected" : ""}>Daily</option><option value="weekly" ${freq === "weekly" ? "selected" : ""}>Weekly</option><option value="monthly" ${freq === "monthly" ? "selected" : ""}>Monthly</option></select></div>
        <div class="cf-field"><label class="cf-label">Every</label><input type="number" name="interval" value="${rule?.interval ?? 1}" min="1"></div>
        <div class="cf-field"><label class="cf-label">Ends</label><input type="date" name="end" value="${rule?.endDate ?? ""}"></div>
      </div>
      <div data-rec-weekdays ${freq !== "weekly" ? "hidden" : ""}>Weekdays: ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => `<label><input type="checkbox" name="wd" value="${i}" ${weekdays.includes(i) ? "checked" : ""}>${d}</label>`).join(" ")}</div>
    </div>
    ${rule ? `<p class="muted">${esc(recurrenceSummary(rule))} <button type="button" data-skip="${row.id}">Skip occurrence</button> <button type="button" data-stop="${row.id}">Stop recurring</button></p>` : ""}`;
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
  return `<h4>Links</h4>
    ${uniq.map((l) => `<div class="row"><span class="badge">${esc(l.type)}</span><span class="row-title" data-open="${l.type}:${l.id}">${esc(l.row.title)}</span><button data-remove-link="${fromType}:${fromId}:${l.type}:${l.id}">Remove</button></div>`).join("") || "<p class='muted'>No links.</p>"}
    <form data-add-link="${fromType}:${fromId}" class="form inline inline-add">
      <select name="linkType">${["tasks", "notes", "people", "reading_items", "projects"].map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
      <select name="linkId"></select>
      <button>Add link</button>
    </form>`;
}
function refreshLinkOptions(form) {
  const type = form.querySelector("[name=linkType]").value;
  const sel = form.querySelector("[name=linkId]");
  sel.innerHTML = allRows(type).map((r) => `<option value="${r.id}">${esc(r.title)}</option>`).join("");
}

function openTaskPopup(id) {
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
  openPopup(t.title, `
    <form data-edit-task="${t.id}" id="task-save-form" class="form popup-form">
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
      ${recurrenceForm(t)}
      <h4>Tags</h4>${tagsForm("tasks", id)}
      <h4>Body</h4>${bodyFieldHtml("tasks", id, t.body_markdown, t.body_version)}
      ${subtaskBlock("tasks", id, t.subtasks)}
    </form>
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
    ${parent ? `<p class="muted">Parent: <span class="row-title" data-open="tasks:${parent.id}">${esc(parent.title)}</span></p>` : ""}
    ${linksBlock("tasks", id)}
    <p class="popup-actions"><button type="submit" form="task-save-form" class="primary-btn">Save</button><button type="submit" form="task-save-form">Save and close</button><button data-archive-task="${t.id}">Archive task</button><button data-close-popup>Close</button></p>`, `tasks:${t.id}`);
}

function openNotePopup(id) {
  const n = state.store.getRow("notes", id);
  if (!n) return;
  openPopup(n.title, `
    <form data-edit-note="${n.id}" id="note-save-form" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(n.title)}" required></div>
      <div class="cf-field"><label class="cf-label">Type</label><select name="type"><option value="">—</option>${vocabOptions("notes", "type", n.type).map((v) => `<option value="${esc(v)}" ${v === n.type ? "selected" : ""}>${esc(v)}</option>`).join("")}<option value="__new__">New type…</option></select><div style="margin-top:8px"><input name="typeNew" placeholder="New type" hidden></div></div>
      <div class="cf-field"><label class="cf-label">Date</label><input type="date" name="date" value="${n.date ?? ""}"></div>
      <h4>Tags</h4>${tagsForm("notes", id)}
      <h4>Body</h4>${bodyFieldHtml("notes", id, n.body_markdown, n.body_version)}
    </form>
    ${linksBlock("notes", id)}
    <p class="popup-actions"><button type="submit" form="note-save-form" class="primary-btn">Save</button><button type="submit" form="note-save-form">Save and close</button><button data-archive-note="${n.id}">Archive note</button><button data-close-popup>Close</button></p>`, `notes:${n.id}`);
}

function openPersonPopup(id) {
  const p = state.store.getRow("people", id);
  if (!p) return;
  const noteLinks = state.db.prepare("SELECT from_type, from_id FROM relations WHERE to_type='people' AND to_id=? AND relation_name='people'").all(id);
  const items = noteLinks.map((r) => ({ type: r.from_type, row: state.store.getRow(r.from_type, r.from_id) })).filter((x) => x.row);
  openPopup(p.title, `
    <form data-edit-person="${p.id}" id="person-save-form" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" value="${esc(p.title)}" required></div>
      <div class="cf-field"><label class="cf-label">Role</label>${selectHtml("role", vocabOptions("people", "role", p.role), p.role)}<div style="margin-top:8px">${newValueHtml("roleNew", "New role")}</div></div>
      <h4>Body</h4>${bodyFieldHtml("people", id, p.body_markdown, p.body_version)}
    </form>
    ${items.length ? `<h4>Linked items</h4>${items.map((x) => `<div class="row"><span class="badge">${esc(x.type)}</span><span class="row-title" data-open="${x.type}:${x.row.id}">${esc(x.row.title)}</span></div>`).join("")}` : ""}
    ${linksBlock("people", id)}
    <p class="popup-actions"><button type="submit" form="person-save-form" class="primary-btn">Save</button><button type="submit" form="person-save-form">Save and close</button><button data-archive-person="${p.id}">Archive person</button><button data-close-popup>Close</button></p>`, `people:${p.id}`);
}

function openProjectPopup(id) {
  const p = state.store.getRow("projects", id);
  if (!p) return;
  const related = new Set(state.store.listRelatedTodos(id));
  const tasks = allRows("tasks");
  openPopup(p.title, `
    <form data-edit-project="${p.id}" id="project-save-form" class="form popup-form">
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
    <p class="popup-actions"><button type="submit" form="project-save-form" class="primary-btn">Save</button><button type="submit" form="project-save-form">Save and close</button><button data-archive-project="${p.id}">Archive project</button><button data-close-popup>Close</button></p>`, `projects:${p.id}`);
}

function openReadingPopup(id) {
  const r = state.store.getRow("reading_items", id);
  if (!r) return;
  openPopup(r.title, `
    <form data-edit-reading="${r.id}" id="reading-save-form" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(r.title)}" required></div>
      <div class="cf-field"><label class="cf-label">URL</label><input name="url" value="${esc(r.url ?? "")}" required></div>
      <div class="cf-field"><label class="cf-label">Status</label>${selectHtml("status", vocabValues("reading_items", "status"), r.status, false)}</div>
      <p class="muted">Source: ${esc(r.source ?? "")} · added ${esc(r.added ?? "")}</p>
      <h4>Notes</h4>${bodyFieldHtml("reading_items", id, r.body_markdown, r.body_version)}
    </form>
    ${linksBlock("reading_items", id)}
    <p class="popup-actions"><button type="submit" form="reading-save-form" class="primary-btn">Save</button><button type="submit" form="reading-save-form">Save and close</button><button data-archive-reading="${r.id}">Archive item</button><button data-close-popup>Close</button></p>`, `reading_items:${r.id}`);
}

function openInboxPopup(id) {
  const item = state.store.getRow("inbox_items", id);
  if (!item) return;
  openPopup(item.title, `
    <form data-edit-inbox="${id}" id="inbox-save-form" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(item.title)}"></div>
      <h4>Body</h4>${bodyFieldHtml("inbox_items", id, item.body_markdown, item.body_version)}
    </form>
    <p class="popup-actions"><button type="submit" form="inbox-save-form" class="primary-btn">Save</button><button type="submit" form="inbox-save-form">Save and close</button><button data-move-personal="${id}">Move to Personal Notes</button> <button data-archive-inbox="${id}">Archive</button> <button data-close-popup>Close</button></p>`, `inbox_items:${id}`);
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
  return `<div class="page-actions"><button data-page-back>Back</button><button data-page-edit="${viewRef(view)}">Edit</button>${extra || ""}<button data-page-archive="${viewRef(view)}">Archive</button></div>`;
}
function renderItemPage(view) {
  const { type, id, slug } = view;
  if (type === "tasks") {
    const t = state.store.getRow("tasks", id);
    if (!t) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    const parentId = state.store.getTaskParent(id);
    const parent = parentId ? state.store.getRow("tasks", parentId) : null;
    const children = linkedTitles("tasks", id, "sub_tasks", "tasks");
    const { rule } = parseRecurrence(t.recurrence ?? "");
    const meta = [t.due_date ? `Due ${esc(t.due_date)}` : "", t.priority ? `Priority ${esc(t.priority)}` : "", t.project ? `Project ${esc(t.project)}` : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <h2>${esc(t.title)}</h2>
      ${meta ? `<p class="muted">${meta}</p>` : ""}
      ${parent ? `<p class="muted">Parent: <span class="row-title" data-open-page="tasks:${parent.id}">${esc(parent.title)}</span></p>` : ""}
      ${rule ? `<p class="muted">Repeats: ${esc(recurrenceSummary(rule))}</p>` : ""}
      ${pageTags("tasks", id)}
      ${pageBody(t.body_markdown)}
      ${pageSubtasks(t.subtasks)}
      <h4>Linked subtasks</h4>
      ${children.map((c) => `<div class="row"><span class="row-title" data-open-page="tasks:${c.id}">${esc(c.row.title)}</span></div>`).join("") || "<p class='muted'>No linked subtasks.</p>"}
      ${pageLinks("tasks", id)}`;
  }
  if (type === "notes") {
    const n = state.store.getRow("notes", id);
    if (!n) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    const meta = [n.type ? `Type ${esc(n.type)}` : "", n.date ? esc(n.date) : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <h2>${esc(n.title)}</h2>
      ${meta ? `<p class="muted">${meta}</p>` : ""}
      ${pageTags("notes", id)}
      ${pageBody(n.body_markdown)}
      ${pageLinks("notes", id)}`;
  }
  if (type === "people") {
    const p = state.store.getRow("people", id);
    if (!p) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    const noteLinks = state.db.prepare("SELECT from_type, from_id FROM relations WHERE to_type='people' AND to_id=? AND relation_name='people'").all(id);
    const items = noteLinks.map((r) => ({ type: r.from_type, row: state.store.getRow(r.from_type, r.from_id) })).filter((x) => x.row);
    return `${pageActions(view)}
      <h2>${esc(p.title)}</h2>
      ${p.role ? `<p class="muted">Role ${esc(p.role)}</p>` : ""}
      ${pageBody(p.body_markdown)}
      ${items.length ? `<h4>Linked items</h4>${items.map((x) => `<div class="row"><span class="badge">${esc(x.type)}</span><span class="row-title" data-open-page="${x.type}:${x.row.id}">${esc(x.row.title)}</span></div>`).join("")}` : ""}
      ${pageLinks("people", id)}`;
  }
  if (type === "projects") {
    const p = state.store.getRow("projects", id);
    if (!p) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    const related = state.store.listRelatedTodos(id);
    const meta = [p.category ? `Category ${esc(p.category)}` : "", p.status ? `Status ${esc(p.status)}` : ""].filter(Boolean).join(" · ");
    return `${pageActions(view)}
      <h2>${esc(p.title)}</h2>
      ${meta ? `<p class="muted">${meta}</p>` : ""}
      ${pageBody(p.body_markdown)}
      ${pageSubtasks(p.subtasks)}
      <h4>Related todos</h4>
      ${related.map((tid) => { const t = state.store.getRow("tasks", tid); return t ? `<div class="row"><span class="row-title" data-open-page="tasks:${t.id}">${esc(t.title)}</span></div>` : ""; }).join("") || "<p class='muted'>No related todos.</p>"}
      ${pageLinks("projects", id)}`;
  }
  if (type === "reading_items") {
    const r = state.store.getRow("reading_items", id);
    if (!r) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    return `${pageActions(view)}
      <h2>${esc(r.title)}</h2>
      ${r.url ? `<p><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></p>` : ""}
      ${r.status ? `<p class="muted">Status ${esc(r.status)}</p>` : ""}
      <p class="muted">Source: ${esc(r.source ?? "")} · added ${esc(r.added ?? "")}</p>
      ${pageBody(r.body_markdown)}
      ${pageLinks("reading_items", id)}`;
  }
  if (type === "inbox_items") {
    const item = state.store.getRow("inbox_items", id);
    if (!item) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    return `<div class="page-actions"><button data-page-back>Back</button><button data-page-edit="${viewRef(view)}">Edit</button><button data-page-move="${id}">Move to Personal Notes</button><button data-page-archive="${viewRef(view)}">Archive</button></div>
      <h2>${esc(item.title)}</h2>
      ${pageBody(item.body_markdown)}`;
  }
  if (type === "custom") {
    const def = state.store.getRow("custom_object_types", slug);
    const row = state.store.getRow("custom_objects", id);
    if (!def || !row) return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">This item no longer exists.</p>`;
    const fields = JSON.parse(def.fields_json ?? "[]");
    const vals = JSON.parse(row.fields_json ?? "{}");
    const show = (f) => {
      const v = vals[f.name];
      if (v === undefined || v === null || v === "") return "—";
      if (f.kind === "Yes-No") return v ? "Yes" : "No";
      return esc(String(v));
    };
    return `${pageActions(view)}
      <h2>${esc(row.title)}</h2>
      ${fields.map((f) => `<p><span class="muted">${esc(f.name)}: </span>${show(f)}</p>`).join("")}
      ${pageLinks("custom_objects", id)}`;
  }
  return `<div class="page-actions"><button data-page-back>Back</button></div><p class="muted">Unknown item type.</p>`;
}

// --- Tab renders ---
function render() {
  if (state.searchDirty) { rebuildSearchIndex(); state.searchDirty = false; }
  $("#sync-status").textContent = statusLine();
  $("#net-badge").textContent = navigator.onLine ? "Online" : "Offline";
  renderSidebar();
  $$(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  const main = $("#main");
  if (state.itemView) main.innerHTML = renderItemPage(state.itemView);
  else if (state.tab === "dashboard") main.innerHTML = renderDashboard();
  else if (state.tab === "tasks") main.innerHTML = renderTasks();
  else if (state.tab === "notes") main.innerHTML = renderNotes();
  else if (state.tab === "inbox") main.innerHTML = renderInbox();
  else if (state.tab === "people") main.innerHTML = renderPeople();
  else if (state.tab === "reading") main.innerHTML = renderReading();
  else if (state.tab === "projects") main.innerHTML = renderProjects();
  else if (state.tab === "search") main.innerHTML = renderSearch();
  else if (state.tab === "daily") main.innerHTML = renderDaily();
  else if (state.tab === "management") main.innerHTML = renderManagement();
  else if (state.tab.startsWith("custom:")) main.innerHTML = renderCustomTab(state.tab.slice(7));
  bindMainForms();
  bindExtraForms();
}

function renderDashboard() {
  const conflicts = state.engine.listConflicts();
  return `${weatherPanel()}
  ${dailyWorkspacePanel()}
  <div class="dash-row">${upcomingPanel()}${inboxPanel()}</div>
  ${conflicts.length ? `<div class="panel"><h3>Sync conflicts (${conflicts.length}) — server row kept</h3>` + conflicts.map((c) => {
    let srv = null;
    try { srv = c.server_row_json ? JSON.parse(c.server_row_json) : null; } catch {}
    const title = srv?.title ? `: ${esc(srv.title)}` : "";
    return `<p class="conflict">${esc(c.table_name)} ${esc(c.row_id)}${title} <span class="muted">${esc(c.created_at ?? "")}</span> <button data-conflict-dismiss="${c.id}">Dismiss</button></p>`;
  }).join("") + `</div>` : ""}
  <div class="panel"><form data-dash-search class="form"><input name="q" placeholder="Search DashBen…" style="flex:1"><button>Search</button></form></div>`;
}

function taskRow(t) {
  const today = todayToronto();
  const overdue = !!t.due_date && t.due_date < today;
  let rec = false;
  try {
    const { rule } = parseRecurrence(t.recurrence ?? "");
    rec = !!rule;
  } catch { /* ignore */ }
  return `<div class="row" data-task="${t.id}">
    <input type="checkbox" data-tick="${t.id}" ${t.done ? "checked" : ""}>
    <span class="row-title">${esc(t.title)}</span>
    ${rec ? `<span class="recur" title="Recurring task">↻</span>` : ""}
    ${t.project ? `<span class="project-pill">${esc(t.project)}</span>` : ""}
    ${t.priority ? `<span class="prio">${esc(t.priority)}</span>` : ""}
    <span class="due${overdue ? " overdue" : ""}">${t.due_date ? t.due_date : "No due date"}</span>
  </div>`;
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
    return [...groups.entries()].sort(([a], [b]) => (a === "No project" ? 1 : b === "No project" ? -1 : a.localeCompare(b)));
  };
  const head = `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-task class="primary-btn">New task</button></div>`;
  const toggle = `<div class="form"><button data-tasks-filter="open" class="toggle-btn ${filter === "open" ? "active" : ""}">Open</button><button data-tasks-filter="done" class="toggle-btn ${filter === "done" ? "active" : ""}">Done</button></div>`;
  if (filter === "done") {
    const done = doneTasks();
    return `${head}${toggle}${done.map(taskRow).join("") || "<p class='muted'>Nothing done yet.</p>"}`;
  }
  const groupOrder = groupList(openTasks());
  return `${head}${toggle}${groupOrder.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map(taskRow).join("")}</details>`).join("") || "<p class='muted'>No open tasks.</p>"}`;
}

function openTaskCreatePopup() {
  const projects = vocabValues("tasks", "project");
  const parents = allRows("tasks").slice().sort((a, b) => a.title.localeCompare(b.title));
  openPopup("New task", `
    <form data-create-task-popup class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" required></div>
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
      <div class="cf-field"><label class="cf-label">Details</label><textarea name="body" rows="3" placeholder="Details (optional)"></textarea></div>
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
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "Daily notes" ? -1 : b === "Daily notes" ? 1 : a === "No type" ? 1 : b === "No type" ? -1 : a.localeCompare(b)));
  const noteRow = (n) => `<div class="row" data-note="${n.id}"><span class="row-title">${esc(n.title)}</span><span class="muted">${esc(n.type ?? "")} ${n.date ?? ""}</span></div>`;
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-note class="primary-btn">New note</button></div>
  ${ordered.map(([g, list]) => `<details class="group" ${g === "Daily notes" ? "" : "open"}><summary>${esc(g)} (${list.length})</summary>${list.map(noteRow).join("")}</details>`).join("") || "<p class='muted'>No notes.</p>"}`;
}

function openNoteCreatePopup() {
  const allTags = state.db.prepare("SELECT DISTINCT tag FROM object_tags WHERE object_type='notes' ORDER BY tag").all().map((r) => r.tag);
  openPopup("New note", `
    <form data-create-note-popup class="form popup-form">
      <div class="cf-field"><label class="cf-label">Name</label><input name="title" required></div>
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
      <div class="cf-field"><label class="cf-label">Body</label><textarea name="body" rows="4" placeholder="Body (optional)"></textarea></div>
      <button class="primary-btn">Create note</button>
    </form>`);
}
function openPersonCreatePopup() {
  openPopup("New person", `
    <form data-create-person-popup class="form">
      <input name="title" placeholder="Person name" required>
      <select name="role"><option value="">Role</option>${vocabValues("people", "role").map((r) => `<option>${r}</option>`).join("")}</select>
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
      <div class="cf-field"><label class="cf-label">Description</label><textarea name="body" rows="4" placeholder="Description (optional)"></textarea></div>
      <button class="primary-btn">Create project</button>
    </form>`);
}
function renderInbox() {
  return `<form data-capture class="form"><input name="title" placeholder="Title (optional)"><textarea name="body" rows="3" placeholder="Capture…" required></textarea><button>Capture</button></form>
  ${inboxItems().map((i) => `<div class="row" data-inbox="${i.id}"><span class="row-title">${esc(i.title)}</span><span class="muted">${esc((i.body_markdown ?? "").slice(0, 80))}</span><button data-archive-inbox="${i.id}">Archive</button></div>`).join("") || "<p class='muted'>Inbox empty.</p>"}`;
}

function renderPeople() {
  const groups = new Map();
  for (const r of allRows("people")) {
    const key = r.role || "No role";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No role" ? 1 : b === "No role" ? -1 : a.localeCompare(b)));
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-person class="primary-btn">New person</button></div>
  ${ordered.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((r) => `<div class="row" data-person="${r.id}"><span class="row-title">${esc(r.title)}</span>${r.role ? `<span class="project-pill">${esc(r.role)}</span>` : ""}</div>`).join("")}</details>`).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
}

function renderReading() {
  const statusOrder = vocabValues("reading_items", "status");
  const groups = new Map();
  for (const r of allRows("reading_items")) {
    const key = r.status || "No status";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const ai = statusOrder.indexOf(a), bi = statusOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
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
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === "No category" ? 1 : b === "No category" ? -1 : a.localeCompare(b)));
  return `<div style="display:flex;justify-content:flex-end;align-items:center"><button data-new-project class="primary-btn">New project</button></div>
  ${ordered.map(([g, list]) => `<details class="group" open><summary>${esc(g)} (${list.length})</summary>${list.map((r) => `<div class="row" data-project="${r.id}"><span class="row-title">${esc(r.title)}</span>${r.status ? `<span class="project-pill">${esc(r.status)}</span>` : ""}${r.category ? `<span class="muted">${esc(r.category)}</span>` : ""}</div>`).join("")}</details>`).join("") || "<p class='muted'>Nothing here yet.</p>"}`;
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
    state.store.captureInbox({ title: d.get("title") || "", body: d.get("body") });
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

function bindPopupForms() {
  const root = $("#popup-root");
  // Subtask Add only appends a row to the checklist in the popup;
  // the merged Save persists the whole list.
  $$("[data-add-sub-btn]", root).forEach((btn) => btn.addEventListener("click", () => {
    const form = btn.closest("form");
    const input = form.querySelector("[data-sub-new]");
    const list = form.querySelector("[data-sub-list]");
    const text = input.value.trim();
    if (!text || !list) return;
    list.querySelector("p.muted")?.remove();
    list.insertAdjacentHTML("beforeend", `<div class="row" data-sub-row="s-${Date.now()}"><input type="checkbox"><span data-sub-text>${esc(text)}</span></div>`);
    input.value = "";
    input.focus();
  }));
  // Enter in the subtask box adds it (same as clicking Add) instead of
  // submitting the whole edit form.
  $$("[data-sub-new]", root).forEach((input) => input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    input.closest(".inline-add")?.querySelector("[data-add-sub-btn]")?.click();
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
    const role = d.get("roleNew")?.trim() || d.get("role") || null;
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
  [["[data-edit-task]", "project", "projectNew"], ["[data-edit-note]", "type", "typeNew"], ["[data-edit-project]", "category", "categoryNew"]].forEach(([formSel, selName, newName]) => {
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
    refreshLinkOptions(f);
    f.querySelector("[name=linkType]").addEventListener("change", () => refreshLinkOptions(f));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const [fromType, fromId] = f.dataset.addLink.split(":");
      const d = new FormData(f);
      try { state.store.addLink(fromType, fromId, d.get("linkType"), d.get("linkId")); } catch (err) { alert(err.message); return; }
      render(); saveBytes(); openPopupByRef(fromType, fromId);
    });
  });
}

function attachPersistentListeners() {
  $("#main").addEventListener("click", async (e) => {
    const tick = e.target.closest("[data-tick]");
    if (tick) {
      const id = tick.dataset.tick;
      const row = state.store.getRow("tasks", id);
      if (!row.done) state.store.completeTask(id, todayToronto());
      else state.store.updateProps("tasks", id, { done: 0 });
      render(); saveBytes();
      return;
    }
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
    const inboxRow = e.target.closest("[data-inbox]");
    if (inboxRow && !e.target.closest("button")) { openInboxPopup(inboxRow.dataset.inbox); return; }
    const archI = e.target.closest("[data-archive-inbox]");
    if (archI) { state.store.archiveObject("inbox_items", archI.dataset.archiveInbox); render(); saveBytes(); return; }
  });
  $("#main").addEventListener("change", async (e) => {
    const sel = e.target.closest("[data-reading-status]");
    if (sel) {
      state.store.updateProps("reading_items", sel.dataset.readingStatus, { status: sel.value });
      render(); saveBytes();
    }
  });
  $("#popup-root").addEventListener("click", async (e) => {
    if (e.target.classList.contains("popup-backdrop")) { closePopup(); return; }
    if (e.target.closest("[data-close-popup]")) { closePopup(); return; }
    const pageOpen = e.target.closest("[data-open-page]");
    if (pageOpen) { closePopup(); openPageRef(pageOpen.dataset.openPage); return; }
    const skip = e.target.closest("[data-skip]");
    if (skip) { state.store.skipTaskOccurrence(skip.dataset.skip, todayToronto()); closePopup(); render(); saveBytes(); return; }
    const stop = e.target.closest("[data-stop]");
    if (stop) { state.store.stopRecurrence(stop.dataset.stop); render(); saveBytes(); openTaskPopup(stop.dataset.stop); return; }
    const arch = e.target.closest("[data-archive-task],[data-archive-note],[data-archive-person],[data-archive-project],[data-archive-reading],[data-archive-inbox]");
    if (arch) {
      const table = arch.dataset.archiveTask ? "tasks" : arch.dataset.archiveNote ? "notes" : arch.dataset.archivePerson ? "people" : arch.dataset.archiveProject ? "projects" : arch.dataset.archiveReading ? "reading_items" : "inbox_items";
      const id = arch.dataset.archiveTask ?? arch.dataset.archiveNote ?? arch.dataset.archivePerson ?? arch.dataset.archiveProject ?? arch.dataset.archiveReading ?? arch.dataset.archiveInbox;
      state.store.archiveObject(table, id);
      closePopup(); render(); saveBytes();
      return;
    }
    const move = e.target.closest("[data-move-personal]");
    if (move) {
      const id = move.dataset.movePersonal;
      const item = state.store.getRow("inbox_items", id);
      state.engine.txn(() => {
        state.store.createNote({ title: item.title || (item.body_markdown ?? "").split("\n")[0].slice(0, 60), body: item.body_markdown ?? "" });
        state.store.archiveObject("inbox_items", id);
      });
      closePopup(); render(); saveBytes();
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
async function boot() {
  console.log("[dashben-boot] start");
  loadSettings();
  await loadSecureToken();
  console.log("[dashben-boot] token done");
  // The WASM binary ships as base64 text (vendor/sql-wasm.wasm.b64)
  // because the repo push tooling only accepts UTF-8 files, so the
  // binary .wasm itself is never committed. Decoded here and handed
  // to sql.js directly — same self-hosted bytes, no CDN.
  const b64 = await (await fetch("./vendor/sql-wasm.wasm.b64")).text();
  const bin = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  const SQL = await initSqlJs({ wasmBinary: bin });
  console.log("[dashben-boot] wasm ready");
  const schema = await (await fetch(SCHEMA_URL)).text();
  const bytes = await loadBytes();
  console.log("[dashben-boot] bytes ready", bytes ? bytes.length : null);
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
  console.log("[dashben-boot] db ready");
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
  $$(".tab-btn").forEach((b) => b.addEventListener("click", () => { $("#sidebar").classList.remove("open"); state.tab = b.dataset.tab; state.itemView = null; saveTab(); render(); }));
  $("#sync-btn").addEventListener("click", doSync);
  $("#menu-btn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  // Auto-sync on reconnect: coming back online pushes queued local
  // edits and pulls anything that landed server-side while offline.
  window.addEventListener("online", () => { render(); if (state.booted) doSync(); });
  window.addEventListener("offline", render);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) captureSharedText(); });
  attachPersistentListeners();
  attachExtraListeners();
  // Reload lands on the tab that was open, not always the dashboard.
  try {
    const s = JSON.parse(localStorage.getItem("pkm-local-settings") || "{}");
    if (s.tab && allTabIds().includes(s.tab)) state.tab = s.tab;
  } catch {}
  render();
  console.log("[dashben-boot] rendered");
  await captureSharedText();
  // Auto-sync on launch when we already have local state; on a fresh
  // database, first sync runs on the first manual Sync press (so a
  // missing token doesn't block first paint).
  if (!fresh) await doSync();
}

boot().catch((e) => {
  document.querySelector("#main").innerHTML = `<p class="error">Failed to start: ${esc(e.message)}</p>`;
});

// --- Parity P2/P3/P4/P6: Daily, Management, custom types, FTS, themes ---
const DEFAULT_TABS = ["dashboard", "daily", "tasks", "notes", "projects", "reading", "people", "inbox", "search", "management"];
const TAB_LABELS = { dashboard: "Dashboard", daily: "Daily", tasks: "Tasks", notes: "Notes", projects: "Projects", reading: "Reading", people: "People", inbox: "Inbox", search: "Search", management: "Management" };
const MANAGED_FIELD_LIST = [
  ["tasks", "priority"], ["tasks", "project"], ["notes", "type"], ["people", "role"],
  ["reading_items", "status"], ["projects", "status"], ["projects", "category"],
];
const THEMES = [["blueprint", "Blueprint dark"], ["paper", "Paper light"], ["civic", "Civic"], ["minimal", "Minimal light"], ["notebook", "Field notebook"], ["ember", "Ember dark"]];

function getTabPrefs() {
  try {
    const row = state.store.getRow("ui_prefs", "tabs");
    if (!row?.value) return { order: [...DEFAULT_TABS], hidden: [], rearrangeEnabled: true, groups: [] };
    const p = JSON.parse(row.value);
    return { order: Array.isArray(p.order) ? p.order : [...DEFAULT_TABS], hidden: Array.isArray(p.hidden) ? p.hidden : [], rearrangeEnabled: true, groups: Array.isArray(p.groups) ? p.groups : [] };
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
  const theme = state.store.getRow("ui_prefs", "theme")?.value ?? "blueprint";
  if (theme === "blueprint") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
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
  const todos = openTasks().filter((t) => t.due_date === date);
  const overdue = openTasks().filter((t) => t.due_date && t.due_date < date);
  let body = "";
  if (note) {
    const { schedule, notes } = splitSchedule(note.body_markdown ?? "");
    body = `<div class="panel"><h3>Schedule</h3>${schedule.length ? schedule.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No schedule entries yet (lines starting with a time, like 9:00 — Meeting).</p>"}</div>
    <div class="panel"><h3>Notes</h3>${notes.join("\n").trim() ? notes.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No notes yet.</p>"}</div>
    <form data-daily-schedule="${date}" class="form"><input type="time" name="time" required><input name="text" placeholder="Schedule entry, e.g. Meeting with…" style="flex:1" required><button>Add to schedule</button></form>
    <form data-daily-jot="${date}" class="form"><textarea name="jot" rows="3" placeholder="Jot a note…" style="flex:1"></textarea><button>Jot it down</button></form>
    <p><button data-open="notes:${note.id}">Edit daily note</button></p>`;
  } else {
    body = `<p class="muted">No daily note for this date yet.</p><p><button data-create-daily="${date}">Create daily note for ${date}</button></p>`;
  }
  return `<form data-daily-nav class="form">
    <button type="button" data-daily-shift="-1">← Prev</button>
    <input type="date" name="date" value="${date}" data-daily-date>
    <button type="button" data-daily-go>Go</button>
    <button type="button" data-daily-shift="1">Next →</button>
    <button type="button" data-daily-shift="0">Today</button>
  </form>
  <div class="panel"><h3>Overdue (${overdue.length})</h3>${overdue.length ? overdue.map(taskRow).join("") : "<p class='muted'>Nothing overdue.</p>"}</div>
  <div class="panel"><h3>Due Today (${todos.length})</h3>${todos.length ? todos.map(taskRow).join("") : "<p class='muted'>Nothing due this day.</p>"}</div>
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
async function fetchWeather() {
  if (state.weather || state.weatherTried) return;
  state.weatherTried = true;
  try {
    // Same request production uses (today + next 3 days).
    const url = "https://api.open-meteo.com/v1/forecast?latitude=43.4635&longitude=-81.18748&current=temperature_2m&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=America%2FToronto&forecast_days=4";
    const res = await fetch(url);
    if (!res.ok) throw new Error("weather fetch failed");
    state.weather = await res.json();
  } catch { state.weather = null; }
  if (state.tab === "dashboard") render();
}
function weatherPanel() {
  if (!state.weather) {
    if (state.weatherTried) return `<div class="panel"><h3>Weather — Mitchell, Ontario</h3><p class="muted">Weather unavailable right now — reload to try again.</p></div>`;
    fetchWeather();
    return `<div class="panel"><h3>Weather — Mitchell, Ontario</h3><p class="muted">Loading…</p></div>`;
  }
  const days = state.weather.daily;
  const cards = days.time.map((date, i) => {
    const { icon, condition } = weatherIcon(days.weathercode?.[i] ?? -1);
    const label = i === 0 ? "Today" : new Intl.DateTimeFormat("en-CA", { weekday: "short", timeZone: "America/Toronto" }).format(new Date(`${date}T12:00:00Z`));
    const monthDay = new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", timeZone: "America/Toronto" }).format(new Date(`${date}T12:00:00Z`));
    return `<div class="weather-card"><div><strong>${label}</strong></div><div class="muted">${monthDay}</div><div style="font-size:28px">${icon}</div><div class="muted">${condition}</div><div>${Math.round(days.temperature_2m_max[i])}° / ${Math.round(days.temperature_2m_min[i])}°</div><div class="muted">💧 ${days.precipitation_probability_max?.[i] ?? "?"}%</div></div>`;
  }).join("");
  return `<div class="panel"><h3>Weather — Mitchell, Ontario</h3><p class="muted">${Math.round(state.weather.current.temperature_2m)}° now</p><div class="weather-grid">${cards}</div></div>`;
}
function dailyWorkspacePanel() {
  const today = todayToronto();
  const note = dailyNoteFor(today);
  const todos = openTasks().filter((t) => t.due_date && t.due_date <= today);
  let inner = "";
  if (note) {
    const { schedule, notes } = splitSchedule(note.body_markdown ?? "");
    inner = `<div class="panel"><h3>Todos</h3>${todos.length ? todos.map(taskRow).join("") : "<p class='muted'>Nothing due today.</p>"}</div>
    <h4>Schedule</h4>${schedule.length ? schedule.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No schedule yet.</p>"}
    <h4>Notes</h4>${notes.join("\n").trim() ? notes.map((l) => `<p>${esc(l)}</p>`).join("") : "<p class='muted'>No notes yet.</p>"}
    <form data-daily-jot="${today}" class="form"><input name="jot" placeholder="Jot a note…" style="flex:1"><button>Add note</button></form>
    <p><button data-open="notes:${note.id}">Open full note</button></p>`;
  } else {
    inner = `<div class="panel"><h3>Todos</h3>${todos.length ? todos.map(taskRow).join("") : "<p class='muted'>Nothing due today.</p>"}</div>
    <p class="muted">No daily note for today yet.</p><p><button data-create-daily="${today}">Create today's daily note</button></p>`;
  }
  return `<div class="panel"><h3>Daily Note</h3><p><button data-daily-tab>Open Daily tab →</button></p>${inner}</div>`;
}
function upcomingPanel() {
  const today = todayToronto();
  const d = new Date(today + "T12:00:00");
  const addDays = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  const tomorrow = addDays(1), weekEnd = addDays(7);
  const overdue = openTasks().filter((t) => t.due_date && t.due_date < today);
  const dueToday = openTasks().filter((t) => t.due_date === today);
  const dueTomorrow = openTasks().filter((t) => t.due_date === tomorrow);
  const dueWeek = openTasks().filter((t) => t.due_date && t.due_date > tomorrow && t.due_date <= weekEnd);
  const section = (label, list) => `<h4>${label} (${list.length})</h4>${list.length ? list.map(taskRow).join("") : "<p class='muted'>None.</p>"}`;
  return `<div class="panel"><h3>Upcoming</h3>
  ${section("Overdue", overdue)}
  ${section("Due Today", dueToday)}
  ${section("Due Tomorrow", dueTomorrow)}
  ${section("Due This Week", dueWeek)}
  <form data-dash-task class="form"><input name="title" placeholder="New task" required><button>+ New task</button></form></div>`;
}
function inboxPanel() {
  const items = inboxItems();
  return `<div class="panel"><h3>Inbox (${items.length})</h3>
  ${items.map((i) => `<div class="row" data-inbox="${i.id}"><span class="row-title">${esc(i.title)}</span><span class="muted">${esc((i.body_markdown ?? "").slice(0, 80))}</span></div>`).join("") || "<p class='muted'>Inbox empty.</p>"}
  <form data-capture class="form"><input name="title" placeholder="Title (optional)"><textarea name="body" rows="2" placeholder="Capture…" required></textarea><button>+ Capture to inbox</button></form></div>`;
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

function renderManagement() {
  const prefs = getTabPrefs();
  const allTags = state.db.prepare("SELECT DISTINCT tag FROM object_tags ORDER BY tag").all().map((r) => r.tag);
  const types = state.db.prepare("SELECT * FROM custom_object_types ORDER BY name").all();
  const currentTheme = state.store.getRow("ui_prefs", "theme")?.value ?? "blueprint";
  const ungrouped = allTabIds().filter((id) => !prefs.groups.some((g) => (g.tabs ?? []).includes(id)));
  const knownTabs = allTabIds();
  const order = [...prefs.order.filter((id) => knownTabs.includes(id)), ...knownTabs.filter((id) => !prefs.order.includes(id))];
  return `<div class="panel"><h3>Sync</h3><p class="muted">Your data syncs with pkm.ben-cloud.net. Saving a token starts a sync — delete any test items first, since later syncs upload local changes.</p>
  <div class="token-card"><label for="sync-token-input">Sync token</label>
  <input id="sync-token-input" type="password" autocomplete="off" placeholder="SYNC_TOKEN">
  <button data-token-save class="ghost-btn">Save token</button>
  <button data-full-sync class="ghost-btn">Re-download everything</button>
  <span class="muted">${state.token ? "Token saved" : "No token set"}</span></div></div>
  <div class="panel"><h3>Field values</h3><p class="muted">Selectable values for every field on every object type. Renaming a value renames it on every row using it. Deleting a value that is in use is blocked.</p>
  ${MANAGED_FIELD_LIST.map(([ot, f]) => `<h4>${ot}.${f}</h4>
    ${vocabValues(ot, f).map((v) => `<form data-fv-rename class="form inline"><input type="hidden" name="objectType" value="${ot}"><input type="hidden" name="field" value="${f}"><input type="hidden" name="old" value="${esc(v)}"><input name="new" value="${esc(v)}"><button>Rename</button><button type="button" data-fv-delete="${ot}|${f}|${esc(v)}">Delete</button></form>`).join("")}
    <form data-fv-add class="form inline"><input type="hidden" name="objectType" value="${ot}"><input type="hidden" name="field" value="${f}"><input name="value" placeholder="New value"><button>Add</button></form>`).join("")}</div>
  <div class="panel"><h3>Tags</h3><p class="muted">Renaming a tag renames it on every item using it; deleting removes it from every item using it.</p>
  ${allTags.map((t) => `<form data-tag-rename class="form inline"><input type="hidden" name="old" value="${esc(t)}"><input name="new" value="${esc(t)}"><button>Rename</button><button type="button" data-tag-delete="${esc(t)}">Delete</button></form>`).join("") || "<p class='muted'>No tags yet.</p>"}</div>
  <div class="panel"><h3>Theme</h3><p class="muted">Current: ${esc(THEMES.find(([v]) => v === currentTheme)?.[1] ?? currentTheme)}</p>
  ${THEMES.map(([v, label]) => `<button data-theme-btn="${v}" ${v === currentTheme ? "disabled" : ""}>${label}</button>`).join(" ")}</div>
  <div class="panel"><h3>Tab groups</h3>
  ${prefs.groups.map((g) => `<div><form data-group-rename class="form inline"><input type="hidden" name="id" value="${g.id}"><input name="label" value="${esc(g.label)}"><button>Rename</button><button type="button" data-group-delete="${g.id}">Delete group</button></form>
    ${(g.tabs ?? []).map((tid) => `<p class="muted" style="margin-left:16px">${esc(tabLabel(tid))} <button data-group-remove-tab="${g.id}|${tid}">Remove</button></p>`).join("")}</div>`).join("") || "<p class='muted'>No groups yet.</p>"}
  <form data-group-create class="form inline"><input name="label" placeholder="New group name" required><button>Create group</button></form>
  <p><button data-reset-tabs>Reset tabs</button></p>
  <h4>Ungrouped tabs</h4>
  ${ungrouped.map((tid) => `<form data-group-add-tab class="form inline"><span>${esc(tabLabel(tid))}</span><input type="hidden" name="tab" value="${tid}"><select name="group">${prefs.groups.map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join("")}</select><button ${prefs.groups.length ? "" : "disabled"}>Add to group</button></form>`).join("")}</div>
  <div class="panel"><h3>Tab order</h3><p class="muted">Drag tabs to reorder them, then save.</p>
  <ul data-tab-order-list>${order.map((tid) => `<li draggable="true" data-tab-order-item="${tid}">☰ ${esc(tabLabel(tid))}</li>`).join("")}</ul>
  <p><button data-tab-order-save>Save</button></p></div>
  <div class="panel"><h3>Custom object types</h3>
  ${types.map((t) => `<p>${esc(t.name)} (${esc(t.slug)}) — ${JSON.parse(t.fields_json ?? "[]").map((f) => `${esc(f.name)} (${esc(f.kind)})`).join(", ") || "no fields"} <button data-custom-tab-toggle="${t.slug}|${t.has_tab ? 0 : 1}">${t.has_tab ? "Remove tab" : "Add tab"}</button></p>`).join("") || "<p class='muted'>No custom types yet.</p>"}
  <form data-create-custom-type class="form"><input name="name" placeholder="Type name (e.g. Book)" required>
    <div data-field-rows style="display:flex;gap:8px;flex-wrap:wrap"><span class="field-row"><input name="fname" placeholder="Field name"><select name="fkind"><option>Text</option><option>Long text</option><option>Date</option><option>Number</option><option>Yes-No</option></select></span></div>
    <button type="button" data-add-field-row>Add field</button><button>Create type</button></form></div>`;
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

function openCustomPopup(slug, id) {
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
  openPopup(row.title, `
    <form data-edit-custom="${slug}:${id}" class="form popup-form">
      <div class="cf-field"><label class="cf-label">Title</label><input name="title" value="${esc(row.title)}" required></div>
      ${fields.map(fieldInput).join("")}
      <button class="primary-btn">Save</button> <button>Save and close</button>
    </form>
    <p><button data-archive-custom="${id}">Archive</button> <button data-close-popup>Close</button></p>`, `custom:${slug}:${id}`);
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
  $$("[data-dash-task]", main).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = (new FormData(f).get("title") || "").trim();
    if (!title) return;
    state.store.createTask({ title });
    render(); saveBytes();
  }));
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
function bindCreateWidgets() {
  const root = $("#popup-root");
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

function bindExtraPopupForms() {
  bindCreateWidgets();
  const root0 = $("#popup-root");
  $$("[data-create-task-popup]", root0).forEach((f) => {
    const freq = f.querySelector("[name=freq]");
    freq.addEventListener("change", () => { f.querySelector("[data-weekdays]").hidden = freq.value !== "weekly"; });
    const proj = f.querySelector("[name=project]");
    proj.addEventListener("change", () => { f.querySelector("[name=projectNew]").hidden = proj.value !== "__new__"; });
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
  const root = $("#popup-root");
  $$("[data-create-note-popup]", root).forEach((f) => {
    const typeSel = f.querySelector("[name=type]");
    typeSel.addEventListener("change", () => { f.querySelector("[name=typeNew]").hidden = typeSel.value !== "__new__"; });
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
  $$("[data-create-person-popup]", root).forEach((f) => f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const d = new FormData(f);
    state.store.createPerson({ title: d.get("title"), role: d.get("role") || null });
    closePopup(); render(); saveBytes();
  }));
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
  $("#main").addEventListener("click", async (e) => {
    const pageBack = e.target.closest("[data-page-back]");
    if (pageBack) { state.itemView = null; render(); return; }
    const fullSync = e.target.closest("[data-full-sync]");
    if (fullSync) { await doFullSync(); return; }
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
        await doSync();
      } catch { /* save/sync failure shows via status line + header on next render */ }
      render(); saveBytes();
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
      state.store.archiveObject(v.type === "custom" ? "custom_objects" : v.type, v.id);
      state.itemView = null; render(); saveBytes(); return;
    }
    const pageMove = e.target.closest("[data-page-move]");
    if (pageMove) {
      const item = state.store.getRow("inbox_items", pageMove.dataset.pageMove);
      if (item) {
        state.engine.txn(() => {
          state.store.createNote({ title: item.title || (item.body_markdown ?? "").split("\n")[0].slice(0, 60), body: item.body_markdown ?? "" });
          state.store.archiveObject("inbox_items", item.id);
        });
        saveBytes();
      }
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
    const tabOrderSave = e.target.closest("[data-tab-order-save]");
    if (tabOrderSave) {
      const order = $$("[data-tab-order-item]").map((el) => el.dataset.tabOrderItem);
      const prefs = getTabPrefs();
      prefs.order = order;
      state.store.setTabPrefs(prefs);
      await saveBytes();
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
    const createDaily = e.target.closest("[data-create-daily]");
    if (createDaily) {
      const date = createDaily.dataset.createDaily;
      const note = state.store.createNote({ title: date, date });
      render(); saveBytes(); openNotePopup(note.id);
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
      state.store.archiveObject("custom_objects", arch.dataset.archiveCustom);
      closePopup(); render(); saveBytes();
      return;
    }
  });
}
