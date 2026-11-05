// PKM local write paths (Phase 2, M2). Domain operations on top of
// SyncEngine that mirror the server routes' rules, so offline behavior
// matches online behavior: recurrence spawning, monthly anchoring,
// skip/stop, subtask validation, tag/relation set replacement,
// archive instead of delete, body versioning. Every operation writes
// through engine.localWrite, so every local change is queued for sync.
// Dates are YYYY-MM-DD strings compared lexicographically (UTC day
// arithmetic, same as the server). "Today" is passed in so tests can
// pin it; the UI passes the Toronto date.

import { SyncEngine } from "./sync-engine.mjs";

export function addDaysISO(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function utcDay(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

function addMonthsClamped(anchor, months, dayOfMonth) {
  const [y, m, d] = anchor.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(dayOfMonth ?? d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

// Port of the server's parseRecurrence (db.ts). Accepts a stored
// string, a rule object, or null/'' (clear).
export function parseRecurrence(value) {
  if (value === null || value === undefined || value === "") return { rule: null, error: null };
  let obj = value;
  if (typeof value === "string") {
    try { obj = JSON.parse(value); } catch { return { rule: null, error: "Recurrence is not valid JSON." }; }
  }
  if (!obj || typeof obj !== "object") return { rule: null, error: "Recurrence must be an object." };
  if (obj.freq !== "daily" && obj.freq !== "weekly" && obj.freq !== "monthly") {
    return { rule: null, error: "Recurrence frequency must be daily, weekly, or monthly." };
  }
  const interval = Number(obj.interval ?? 1);
  const maxInterval = obj.freq === "weekly" ? 52 : 365;
  if (!Number.isInteger(interval) || interval < 1 || interval > maxInterval) {
    return { rule: null, error: `Recurrence interval must be 1–${maxInterval}.` };
  }
  let weekdays = [];
  if (obj.freq === "weekly") {
    if (!Array.isArray(obj.weekdays) || obj.weekdays.length === 0) {
      return { rule: null, error: "Weekly recurrence needs at least one weekday." };
    }
    const seen = new Set();
    for (const w of obj.weekdays) {
      const n = Number(w);
      if (!Number.isInteger(n) || n < 0 || n > 6) return { rule: null, error: "Weekdays must be 0 (Sunday) through 6 (Saturday)." };
      seen.add(n);
    }
    weekdays = [...seen].sort((a, b) => a - b);
  }
  let endDate = null;
  if (typeof obj.endDate === "string" && obj.endDate.trim()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(obj.endDate.trim())) return { rule: null, error: "Recurrence end date must be YYYY-MM-DD." };
    endDate = obj.endDate.trim();
  }
  let dayOfMonth = null;
  if (obj.freq === "monthly" && obj.dayOfMonth !== undefined && obj.dayOfMonth !== null) {
    const dom = Number(obj.dayOfMonth);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return { rule: null, error: "Monthly day-of-month must be 1–31." };
    dayOfMonth = dom;
  }
  return { rule: { freq: obj.freq, interval, weekdays, endDate, dayOfMonth }, error: null };
}

// Port of the server's nextRecurrenceDue (db.ts): the first occurrence
// strictly after the anchor due date that is not in the past, so
// overdue instances roll forward TO today when today matches the
// pattern (Ben, Nov 4, 2026: checking off an overdue daily item spawns
// today's instance, not tomorrow's); on-time completion still lands on
// the next future occurrence. Monthly
// steps from the original anchor with day clamping, so a 31st task
// lands on the 28th in February and back on the 31st in March.
export function nextRecurrenceDue(rule, anchorDue, today) {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorDue) ? anchorDue : today;
  const pastEnd = (cand) => rule.endDate !== null && cand > rule.endDate;
  if (rule.freq === "daily") {
    let k = 1;
    while (k <= 100000) {
      const cand = addDaysISO(anchor, k * rule.interval);
      if (cand >= today) return pastEnd(cand) ? null : cand;
      k++;
    }
    return null;
  }
  if (rule.freq === "monthly") {
    const dom = rule.dayOfMonth ?? Number(anchor.split("-")[2]);
    let k = 1;
    while (k <= 1200) {
      const cand = addMonthsClamped(anchor, k * rule.interval, dom);
      if (cand >= today) return pastEnd(cand) ? null : cand;
      if (pastEnd(cand)) return null;
      k++;
    }
    return null;
  }
  const anchorWeekStart = addDaysISO(anchor, -utcDay(anchor));
  const nextWeeklyAfter = (from) => {
    let d = addDaysISO(from, 1);
    const limit = addDaysISO(from, rule.interval * 7 + 7);
    while (d <= limit) {
      const weekIdx = Math.floor((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${anchorWeekStart}T00:00:00Z`)) / 86400000 / 7);
      if (rule.weekdays.includes(utcDay(d)) && weekIdx % rule.interval === 0) return d;
      d = addDaysISO(d, 1);
    }
    return null;
  };
  let cand = nextWeeklyAfter(anchor);
  while (cand !== null && cand < today) cand = nextWeeklyAfter(cand);
  if (cand === null) return null;
  return pastEnd(cand) ? null : cand;
}

export function recurrenceSummary(rule) {
  const every = rule.interval === 1 ? "" : ` every ${rule.interval}`;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let base = "";
  if (rule.freq === "daily") base = rule.interval === 1 ? "Repeats daily" : `Repeats every ${rule.interval} days`;
  else if (rule.freq === "weekly") base = `Repeats${every} week${rule.interval === 1 ? "" : "s"} on ${rule.weekdays.map((w) => dayNames[w]).join(", ")}`;
  else base = rule.interval === 1 ? "Repeats monthly" : `Repeats every ${rule.interval} months`;
  return rule.endDate ? `${base} · ends ${rule.endDate}` : base;
}

// Port of the server's parseSubtasks (task-update.ts).
export function parseSubtasks(value) {
  if (!Array.isArray(value)) return { list: [], error: "Subtasks must be an array." };
  const seen = new Set();
  const list = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { list: [], error: "Each subtask must be an object." };
    if (typeof item.id !== "string" || !item.id.trim()) return { list: [], error: "Each subtask needs a non-empty id." };
    if (seen.has(item.id)) return { list: [], error: "Subtask ids must be unique." };
    seen.add(item.id);
    if (typeof item.text !== "string" || !item.text.trim()) return { list: [], error: "Each subtask needs non-empty text." };
    if (item.done !== 0 && item.done !== 1 && item.done !== true && item.done !== false) {
      return { list: [], error: "Each subtask done flag must be 0/1." };
    }
    list.push({ id: item.id, text: item.text.trim(), done: item.done === 1 || item.done === true ? 1 : 0 });
  }
  return { list, error: null };
}

function newId() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function parseFlags(row) {
  try {
    const parsed = JSON.parse(row?.body_flags ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

const MANAGED_FIELDS = [
  { objectType: "tasks", field: "priority", table: "tasks", column: "priority" },
  { objectType: "tasks", field: "project", table: "tasks", column: "project" },
  { objectType: "notes", field: "type", table: "notes", column: "type" },
  { objectType: "people", field: "role", table: "people", column: "role" },
  { objectType: "reading_items", field: "status", table: "reading_items", column: "status" },
  { objectType: "projects", field: "status", table: "projects", column: "status" },
  { objectType: "projects", field: "category", table: "projects", column: "category" },
];

export class LocalStore {
  constructor(engine) {
    this.engine = engine;
    this.db = engine.db;
  }

  getRow(table, id) {
    const col = table === "custom_object_types" ? "slug" : table === "ui_prefs" ? "key" : "id";
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${col}=?`).get(id) ?? null;
  }

  listTags(objectType, objectId) {
    return this.db.prepare("SELECT tag FROM object_tags WHERE object_type=? AND object_id=? ORDER BY tag")
      .all(objectType, objectId).map((r) => r.tag);
  }

  // --- Generic object writes (mirror the server routes) ---

  createObject(table, fields) {
    const id = newId();
    const ts = new Date().toISOString();
    const body = fields.body_markdown ?? "";
    const row = {
      id, created_at: ts, updated_at: ts, archived: 0,
      body_markdown: body, body_version: body ? 1 : 0,
      body_updated_at: body ? ts : null, body_flags: "[]",
      ...fields, id, created_at: ts, updated_at: ts,
    };
    delete row.body;
    this.engine.localWrite(table, row, { baseUpdatedAt: null });
    return row;
  }

  createTask({ title, due = null, priority = null, project = null, body = "", recurrence = null }) {
    if (!title?.trim()) throw new Error("Task name is required.");
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error("Due date must be YYYY-MM-DD.");
    let rule = null, group = null, recurrenceJson = "";
    if (recurrence !== null && recurrence !== undefined && recurrence !== "") {
      const parsed = parseRecurrence(recurrence);
      if (parsed.error) throw new Error(parsed.error);
      rule = parsed.rule;
      if (rule) {
        if (rule.freq === "monthly" && !rule.dayOfMonth && /^\d{4}-\d{2}-\d{2}$/.test(due ?? "")) {
          rule.dayOfMonth = Number(due.split("-")[2]);
        }
        recurrenceJson = JSON.stringify(rule);
        group = newId();
      }
    }
    return this.createObject("tasks", {
      title: title.trim(), done: 0, due_date: due, priority, project, place: null,
      subtasks: "[]", recurrence: recurrenceJson, recurrence_group: group,
      body_markdown: body,
    });
  }

  createNote({ title, date = null, type = "General Notes", body = "" }) {
    if (!title?.trim()) throw new Error("Note title is required.");
    const clean = title.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) type = "Daily Notes";
    return this.createObject("notes", { title: clean, date, type, body_markdown: body });
  }

  createPerson({ title, role = null, body = "" }) {
    if (!title?.trim()) throw new Error("Person name is required.");
    return this.createObject("people", { title: title.trim(), role, body_markdown: body });
  }

  createReading({ title, url, note = "" }) {
    if (!title?.trim() || !url?.trim()) throw new Error("Reading title and URL are required.");
    let source = "";
    try { source = new URL(url).hostname.replace(/^www\./, ""); } catch { source = ""; }
    return this.createObject("reading_items", {
      title: title.trim(), url: url.trim(), status: "To read", source,
      added: new Date().toISOString().slice(0, 10), body_markdown: note,
    });
  }

  createProject({ title, category = null, status = null, body = "" }) {
    if (!title?.trim()) throw new Error("Project name is required.");
    return this.createObject("projects", { title: title.trim(), category, status, subtasks: "[]", body_markdown: body });
  }

  captureInbox({ title, body }) {
    if (!body?.trim()) throw new Error("Inbox body is required.");
    const ts = new Date().toISOString();
    const row = {
      id: newId(),
      title: (title ?? "").trim() || body.split("\n")[0].slice(0, 60),
      noted: null, body_markdown: body, body_version: 1, body_updated_at: ts,
      body_flags: "[]", created_at: ts, updated_at: ts, archived: 0,
    };
    this.engine.localWrite("inbox_items", row, { baseUpdatedAt: null });
    return row;
  }

  // Properties-only update: body columns are rejected, like the server.
  updateProps(table, id, sets) {
    for (const col of Object.keys(sets)) {
      if (col === "body_markdown" || col === "body_version" || col === "body_updated_at") {
        throw new Error(`updateProps must never touch ${col}; use saveBody.`);
      }
    }
    const row = this.getRow(table, id);
    if (!row) throw new Error(`No ${table} row with id ${id}.`);
    const ts = new Date().toISOString();
    const next = { ...row, ...sets, updated_at: ts };
    this.engine.localWrite(table, next, { baseUpdatedAt: row.updated_at });
    return next;
  }

  saveBody(table, id, newBody, expectedVersion = undefined) {
    const row = this.getRow(table, id);
    if (!row) throw new Error(`No ${table} row with id ${id}.`);
    const flags = parseFlags(row);
    if (flags.length > 0) {
      throw new Error(`Cannot edit this body in the app: it contains ${flags.join(", ")} blocks from Notion. Resolve them in the Notion archive first.`);
    }
    if (expectedVersion !== undefined && expectedVersion !== row.body_version) {
      throw new Error(`Body version conflict: expected ${expectedVersion}, current is ${row.body_version}.`);
    }
    if (newBody === (row.body_markdown ?? "")) return { unchanged: true, version: row.body_version };
    const ts = new Date().toISOString();
    const next = { ...row, body_markdown: newBody, body_version: row.body_version + 1, body_updated_at: ts, updated_at: ts };
    this.engine.localWrite(table, next, { baseUpdatedAt: row.updated_at });
    return { unchanged: false, version: next.body_version };
  }

  setSubtasks(table, id, subtasks) {
    const { list, error } = parseSubtasks(subtasks);
    if (error) throw new Error(error);
    return this.updateProps(table, id, { subtasks: JSON.stringify(list) });
  }

  addAttachment(ownerType, ownerId, mime, data, name = null) {
    const ts = new Date().toISOString();
    const row = { id: newId(), owner_type: ownerType, owner_id: ownerId, mime, data, name, created_at: ts, updated_at: ts, archived: 0 };
    this.engine.localWrite("attachments", row, { baseUpdatedAt: null });
    return row;
  }

  attachmentsFor(ownerType, ownerId) {
    return this.db.prepare("SELECT * FROM attachments WHERE owner_type=? AND owner_id=? AND archived=0 ORDER BY created_at").all(ownerType, ownerId);
  }

  copyAttachments(fromType, fromId, toType, toId) {
    for (const a of this.attachmentsFor(fromType, fromId)) this.addAttachment(toType, toId, a.mime, a.data, a.name ?? null);
  }

  archiveAttachment(id) {
    return this.archiveObject("attachments", id);
  }

  reassignAttachments(fromType, fromId, toType, toId) {
    for (const a of this.attachmentsFor(fromType, fromId)) {
      const ts = new Date().toISOString();
      this.engine.localWrite("attachments", { ...a, owner_type: toType, owner_id: toId, updated_at: ts }, { baseUpdatedAt: a.updated_at });
    }
  }

  archiveObject(table, id) {
    const row = this.getRow(table, id);
    if (!row) throw new Error(`No ${table} row with id ${id}.`);
    const ts = new Date().toISOString();
    const next = { ...row, archived: 1, updated_at: ts };
    this.engine.localWrite(table, next, { baseUpdatedAt: row.updated_at });
    return next;
  }

  unarchiveObject(table, id) {
    const row = this.getRow(table, id);
    if (!row) throw new Error(`No ${table} row with id ${id}.`);
    const ts = new Date().toISOString();
    const next = { ...row, archived: 0, updated_at: ts };
    this.engine.localWrite(table, next, { baseUpdatedAt: row.updated_at });
    return next;
  }

  // --- Recurrence (mirrors server spawnNextInstance + task-update) ---

  spawnNextInstance(row, today) {
    const { rule } = parseRecurrence(row.recurrence ?? "");
    if (!rule) return null;
    const nextDue = nextRecurrenceDue(rule, row.due_date ?? "", today);
    if (!nextDue) return null;
    const group = row.recurrence_group || newId();
    let subtasks = "[]";
    try {
      const parsed = JSON.parse(row.subtasks ?? "[]");
      if (Array.isArray(parsed)) {
        subtasks = JSON.stringify(parsed
          .filter((t) => t && typeof t.id === "string" && typeof t.text === "string")
          .map((t) => ({ id: t.id, text: t.text, done: 0 })));
      }
    } catch { subtasks = "[]"; }
    const ts = new Date().toISOString();
    const markdown = row.body_markdown ?? "";
    const spawned = {
      id: newId(),
      title: row.title, done: 0, due_date: nextDue, priority: row.priority ?? null,
      project: row.project ?? null, place: row.place ?? null,
      body_markdown: markdown, body_version: markdown ? 1 : 0,
      body_updated_at: markdown ? ts : null, body_flags: row.body_flags ?? "[]",
      created_at: ts, updated_at: ts, archived: 0, subtasks,
      recurrence: JSON.stringify(rule), recurrence_group: group,
    };
    return { spawned, group };
  }

  // Complete a task. If it was open and recurring, the done row stays
  // as history and a next instance spawns (same rule, checklist
  // unticked, due advanced). Returns { row, spawned }.
  completeTask(id, today) {
    const row = this.getRow("tasks", id);
    if (!row) throw new Error(`No task with id ${id}.`);
    if (row.done === 1) return { row, spawned: null };
    let spawned = null;
    this.engine.txn(() => {
      let current = row;
      const { rule } = parseRecurrence(row.recurrence ?? "");
      if (rule && !row.recurrence_group) {
        current = this.updateProps("tasks", id, { recurrence_group: newId() });
      }
      const done = this.updateProps("tasks", id, { done: 1 });
      if (rule) {
        const result = this.spawnNextInstance({ ...current, recurrence: done.recurrence }, today);
        if (result) {
          this.engine.localWrite("tasks", result.spawned, { baseUpdatedAt: null });
          spawned = result.spawned;
        }
      }
      return done;
    });
    return { row: this.getRow("tasks", id), spawned };
  }

  skipTaskOccurrence(id, today) {
    const row = this.getRow("tasks", id);
    if (!row) throw new Error(`No task with id ${id}.`);
    const result = this.spawnNextInstance(row, today);
    let spawned = null;
    this.engine.txn(() => {
      if (result) {
        this.engine.localWrite("tasks", result.spawned, { baseUpdatedAt: null });
        spawned = result.spawned;
      }
      this.archiveObject("tasks", id);
    });
    return { spawned };
  }

  stopRecurrence(id) {
    const row = this.getRow("tasks", id);
    if (!row) throw new Error(`No task with id ${id}.`);
    return this.updateProps("tasks", id, { recurrence: "" });
  }

  setRecurrence(id, recurrence) {
    const row = this.getRow("tasks", id);
    if (!row) throw new Error(`No task with id ${id}.`);
    const { rule, error } = parseRecurrence(recurrence);
    if (error) throw new Error(error);
    let json = "";
    if (rule) {
      if (rule.freq === "monthly" && !rule.dayOfMonth && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date ?? "")) {
        rule.dayOfMonth = Number(row.due_date.split("-")[2]);
      }
      json = JSON.stringify(rule);
    }
    const sets = { recurrence: json };
    if (rule && !row.recurrence_group) sets.recurrence_group = newId();
    return this.updateProps("tasks", id, sets);
  }

  // --- Sets: tags, people, parent, related todos, links ---

  setTags(objectType, objectId, tags) {
    const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
    const current = this.listTags(objectType, objectId);
    this.engine.txn(() => {
      for (const tag of current.filter((t) => !clean.includes(t))) {
        this.engine.localWrite("object_tags", `${objectType}|${objectId}|${tag}`, { op: "delete" });
      }
      for (const tag of clean.filter((t) => !current.includes(t))) {
        this.engine.localWrite("object_tags", { object_type: objectType, object_id: objectId, tag }, { baseUpdatedAt: null });
      }
    });
    return clean;
  }

  listPeople(objectType, objectId) {
    return this.db.prepare(
      "SELECT to_id FROM relations WHERE from_type=? AND from_id=? AND relation_name='people' AND to_type='people' ORDER BY to_id",
    ).all(objectType, objectId).map((r) => r.to_id);
  }

  setPeople(objectType, objectId, peopleIds) {
    const clean = [...new Set(peopleIds.map((x) => String(x).trim()).filter(Boolean))];
    const current = this.listPeople(objectType, objectId);
    this.engine.txn(() => {
      for (const pid of current.filter((p) => !clean.includes(p))) {
        this.engine.localWrite("relations", `${objectType}|${objectId}|people|${pid}|people`, { op: "delete" });
      }
      for (const pid of clean.filter((p) => !current.includes(p))) {
        this.engine.localWrite("relations", { from_type: objectType, from_id: objectId, to_type: "people", to_id: pid, relation_name: "people" }, { baseUpdatedAt: null });
      }
    });
    return clean;
  }

  getTaskParent(taskId) {
    const row = this.db.prepare(
      "SELECT to_id FROM relations WHERE from_type='tasks' AND from_id=? AND relation_name='parent_task' LIMIT 1",
    ).get(taskId);
    return row?.to_id ?? null;
  }

  setTaskParent(taskId, parentId) {
    const child = this.getRow("tasks", taskId);
    if (!child) throw new Error(`No task with id ${taskId}.`);
    if (parentId) {
      const parent = this.getRow("tasks", parentId);
      if (!parent) throw new Error(`No task with id ${parentId}.`);
      if (parentId === taskId) throw new Error("A task cannot be its own parent.");
      let cur = parentId, guard = 0;
      while (cur && guard++ < 100) {
        if (cur === taskId) throw new Error("That link would create a cycle.");
        cur = this.getTaskParent(cur);
      }
    }
    const oldParents = this.db.prepare(
      "SELECT to_id FROM relations WHERE from_type='tasks' AND from_id=? AND relation_name='parent_task'",
    ).all(taskId).map((r) => r.to_id);
    this.engine.txn(() => {
      for (const old of oldParents) {
        this.engine.localWrite("relations", `tasks|${taskId}|tasks|${old}|parent_task`, { op: "delete" });
        this.engine.localWrite("relations", `tasks|${old}|tasks|${taskId}|sub_tasks`, { op: "delete" });
      }
      const doomed = this.db.prepare(
        "SELECT from_type, from_id, to_type, to_id, relation_name FROM relations WHERE to_type='tasks' AND to_id=? AND relation_name='sub_tasks'",
      ).all(taskId);
      for (const r of doomed) {
        if (!oldParents.includes(r.from_id)) {
          this.engine.localWrite("relations", `${r.from_type}|${r.from_id}|${r.to_type}|${r.to_id}|${r.relation_name}`, { op: "delete" });
        }
      }
      if (parentId) {
        this.engine.localWrite("relations", { from_type: "tasks", from_id: taskId, to_type: "tasks", to_id: parentId, relation_name: "parent_task" }, { baseUpdatedAt: null });
        this.engine.localWrite("relations", { from_type: "tasks", from_id: parentId, to_type: "tasks", to_id: taskId, relation_name: "sub_tasks" }, { baseUpdatedAt: null });
      }
    });
  }

  listRelatedTodos(projectId) {
    return this.db.prepare(
      "SELECT to_id FROM relations WHERE from_type='projects' AND from_id=? AND relation_name='related_todo' ORDER BY rowid",
    ).all(projectId).map((r) => r.to_id);
  }

  setRelatedTodos(projectId, taskIds) {
    const project = this.getRow("projects", projectId);
    if (!project) throw new Error(`No project with id ${projectId}.`);
    const seen = new Set();
    for (const tid of taskIds) {
      if (seen.has(tid)) throw new Error("Duplicate task id in related todos.");
      seen.add(tid);
      if (!this.getRow("tasks", tid)) throw new Error(`No task with id ${tid}.`);
    }
    const current = this.listRelatedTodos(projectId);
    this.engine.txn(() => {
      for (const tid of current.filter((t) => !taskIds.includes(t))) {
        this.engine.localWrite("relations", `projects|${projectId}|tasks|${tid}|related_todo`, { op: "delete" });
      }
      for (const tid of taskIds.filter((t) => !current.includes(t))) {
        this.engine.localWrite("relations", { from_type: "projects", from_id: projectId, to_type: "tasks", to_id: tid, relation_name: "related_todo" }, { baseUpdatedAt: null });
      }
    });
    return taskIds;
  }

  addLink(fromType, fromId, toType, toId) {
    if (fromType === toType && fromId === toId) throw new Error("An object cannot link to itself.");
    if (!this.getRow(fromType, fromId)) throw new Error(`No ${fromType} object with id ${fromId}.`);
    if (!this.getRow(toType, toId)) throw new Error(`No ${toType} object with id ${toId}.`);
    const dup = this.db.prepare(
      `SELECT 1 FROM relations WHERE relation_name='link' AND ((from_type=? AND from_id=? AND to_type=? AND to_id=?) OR (from_type=? AND from_id=? AND to_type=? AND to_id=?))`,
    ).get(fromType, fromId, toType, toId, toType, toId, fromType, fromId);
    if (dup) throw new Error("These two objects are already linked.");
    this.engine.localWrite("relations", { from_type: fromType, from_id: fromId, to_type: toType, to_id: toId, relation_name: "link" }, { baseUpdatedAt: null });
  }

  removeLink(fromType, fromId, toType, toId) {
    this.engine.txn(() => {
      for (const [a, b, c, d] of [[fromType, fromId, toType, toId], [toType, toId, fromType, fromId]]) {
        this.engine.localWrite("relations", `${a}|${b}|${c}|${d}|link`, { op: "delete" });
      }
    });
  }

  // --- ui_prefs and field values ---

  getGroupOrder(key) {
    const raw = this.getRow("ui_prefs", `group_order:${key}`)?.value;
    if (!raw) return [];
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
  }

  setGroupOrder(key, values) {
    const ts = new Date().toISOString();
    this.engine.localWrite("ui_prefs", { key: `group_order:${key}`, value: JSON.stringify(values), updated_at: ts }, { baseUpdatedAt: this.getRow("ui_prefs", `group_order:${key}`)?.updated_at ?? null });
  }

  setTabPrefs(prefs) {
    const ts = new Date().toISOString();
    this.engine.localWrite("ui_prefs", { key: "tabs", value: JSON.stringify(prefs), updated_at: ts }, { baseUpdatedAt: this.getRow("ui_prefs", "tabs")?.updated_at ?? null });
  }

  setTheme(theme) {
    const ts = new Date().toISOString();
    this.engine.localWrite("ui_prefs", { key: "theme", value: theme, updated_at: ts }, { baseUpdatedAt: this.getRow("ui_prefs", "theme")?.updated_at ?? null });
  }

  // News feed sources (stamp dh): a JSON list in ui_prefs, synced
  // like every other pref. null = unset (the Worker serves its
  // curated defaults); setFeedSources(null) clears back to unset.
  getFeedSources() {
    const raw = this.getRow("ui_prefs", "feed_sources")?.value;
    if (!raw) return null;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
  }

  // Feed read state (stamp dp): {links: [...opened story links, newest
  // last...], open: <ms epoch of the last Feed visit>}. Synced via
  // ui_prefs so read state follows Ben across phone and web.
  getFeedSeen() {
    const raw = this.getRow("ui_prefs", "feed_seen")?.value;
    if (!raw) return { links: [], open: 0 };
    try { const v = JSON.parse(raw); return { links: Array.isArray(v?.links) ? v.links : [], open: Number(v?.open) || 0 }; } catch { return { links: [], open: 0 }; }
  }

  setFeedSeen(seen) {
    const ts = new Date().toISOString();
    this.engine.localWrite("ui_prefs", { key: "feed_seen", value: JSON.stringify(seen), updated_at: ts }, { baseUpdatedAt: this.getRow("ui_prefs", "feed_seen")?.updated_at ?? null });
  }

  setFeedSources(list) {
    const ts = new Date().toISOString();
    this.engine.localWrite("ui_prefs", { key: "feed_sources", value: list ? JSON.stringify(list) : "", updated_at: ts }, { baseUpdatedAt: this.getRow("ui_prefs", "feed_sources")?.updated_at ?? null });
  }

  addFieldValue(objectType, field, value) {
    const def = MANAGED_FIELDS.find((f) => f.objectType === objectType && f.field === field);
    if (!def) throw new Error(`Unknown managed field: ${objectType}.${field}.`);
    if (!value?.trim()) throw new Error("Add needs a value.");
    const exists = this.db.prepare("SELECT 1 FROM field_values WHERE object_type=? AND field=? AND value=?").get(objectType, field, value);
    if (exists) throw new Error(`A value named "${value}" already exists.`);
    this.engine.localWrite("field_values", { object_type: objectType, field, value }, { baseUpdatedAt: null });
  }

  renameFieldValue(objectType, field, oldValue, newValue) {
    const def = MANAGED_FIELDS.find((f) => f.objectType === objectType && f.field === field);
    if (!def) throw new Error(`Unknown managed field: ${objectType}.${field}.`);
    if (!oldValue || !newValue) throw new Error("Rename needs both the current and new values.");
    const vocab = this.db.prepare("SELECT value FROM field_values WHERE object_type=? AND field=?").all(objectType, field).map((r) => r.value);
    const affected = this.db.prepare(`SELECT * FROM ${def.table} WHERE ${def.column}=?`).all(oldValue);
    if (!vocab.includes(oldValue) && affected.length === 0) throw new Error(`No value named "${oldValue}".`);
    if (newValue !== oldValue && vocab.includes(newValue)) throw new Error(`A value named "${newValue}" already exists.`);
    this.engine.txn(() => {
      if (vocab.includes(oldValue)) {
        this.engine.localWrite("field_values", `${objectType}|${field}|${oldValue}`, { op: "delete" });
      }
      this.engine.localWrite("field_values", { object_type: objectType, field, value: newValue }, { baseUpdatedAt: null });
      // Data rows keep their updated_at (the server rename does not
      // bump it); each rewritten row is still queued so the rename
      // propagates on sync.
      for (const row of affected) {
        const next = { ...row, [def.column]: newValue };
        this.engine.localWrite(def.table, next, { baseUpdatedAt: row.updated_at });
      }
    });
  }

  deleteFieldValue(objectType, field, value) {
    const def = MANAGED_FIELDS.find((f) => f.objectType === objectType && f.field === field);
    if (!def) throw new Error(`Unknown managed field: ${objectType}.${field}.`);
    const used = this.db.prepare(`SELECT COUNT(*) AS n FROM ${def.table} WHERE ${def.column}=?`).get(value).n;
    if (used > 0) throw new Error(`Cannot delete "${value}": it is used by ${used} ${used === 1 ? "row" : "rows"}. Rename it instead.`);
    const exists = this.db.prepare("SELECT 1 FROM field_values WHERE object_type=? AND field=? AND value=?").get(objectType, field, value);
    if (!exists) throw new Error(`No value named "${value}".`);
    this.engine.localWrite("field_values", `${objectType}|${field}|${value}`, { op: "delete" });
  }

  // --- Global tags (notes scope, mirrors production tag management) ---
  renameTag(oldTag, newTag) {
    const t = oldTag?.trim(), n = newTag?.trim();
    if (!t || !n) throw new Error("Rename needs both tags.");
    const rows = this.db.prepare("SELECT * FROM object_tags WHERE tag=?").all(t);
    if (rows.length === 0) throw new Error(`Nothing tagged "${t}".`);
    this.engine.txn(() => {
      for (const r of rows) {
        this.engine.localWrite("object_tags", `${r.object_type}|${r.object_id}|${t}`, { op: "delete" });
        const exists = this.db.prepare("SELECT 1 FROM object_tags WHERE object_type=? AND object_id=? AND tag=?").get(r.object_type, r.object_id, n);
        if (!exists) this.engine.localWrite("object_tags", { object_type: r.object_type, object_id: r.object_id, tag: n }, { baseUpdatedAt: null });
      }
    });
  }

  deleteTag(tag) {
    const t = tag?.trim();
    if (!t) throw new Error("Delete needs a tag.");
    const rows = this.db.prepare("SELECT * FROM object_tags WHERE tag=?").all(t);
    if (rows.length === 0) throw new Error(`Nothing tagged "${t}".`);
    this.engine.txn(() => {
      for (const r of rows) this.engine.localWrite("object_tags", `${r.object_type}|${r.object_id}|${t}`, { op: "delete" });
    });
  }

  // --- Custom object types/objects (mirrors server custom helpers) ---
  createCustomType({ name, fields }) {
    if (!name?.trim()) throw new Error("Type name is required.");
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    if (!slug) throw new Error("Type name must contain letters or numbers.");
    const clean = (fields ?? []).filter((f) => f?.name?.trim()).map((f) => ({ name: f.name.trim(), kind: ["Text", "Long text", "Date", "Number", "Yes-No"].includes(f.kind) ? f.kind : "Text" }));
    const ts = new Date().toISOString();
    const row = { slug, name: name.trim(), fields_json: JSON.stringify(clean), has_tab: 1, created_at: ts, updated_at: ts };
    this.engine.localWrite("custom_object_types", row, { baseUpdatedAt: null });
    return row;
  }

  setCustomTab(slug, hasTab) {
    const row = this.getRow("custom_object_types", slug);
    if (!row) throw new Error(`No custom type "${slug}".`);
    const ts = new Date().toISOString();
    this.engine.localWrite("custom_object_types", { ...row, has_tab: hasTab ? 1 : 0, updated_at: ts }, { baseUpdatedAt: row.updated_at });
  }

  createCustomObject({ type, title, fields }) {
    if (!title?.trim()) throw new Error("Object title is required.");
    const def = this.getRow("custom_object_types", type);
    if (!def) throw new Error(`No custom type "${type}".`);
    const defFields = JSON.parse(def.fields_json ?? "[]");
    const clean = {};
    for (const f of defFields) {
      const v = fields?.[f.name];
      if (v !== undefined && v !== null && v !== "") clean[f.name] = f.kind === "Yes-No" ? (v ? 1 : 0) : v;
    }
    const ts = new Date().toISOString();
    const row = { id: newId(), type, title: title.trim(), fields_json: JSON.stringify(clean), archived: 0, created_at: ts, updated_at: ts };
    this.engine.localWrite("custom_objects", row, { baseUpdatedAt: null });
    return row;
  }

  updateCustomObject(id, { title, fields }) {
    const row = this.getRow("custom_objects", id);
    if (!row) throw new Error(`No custom object "${id}".`);
    const ts = new Date().toISOString();
    const next = { ...row, title: title?.trim() ? title.trim() : row.title, fields_json: JSON.stringify(fields ?? {}), updated_at: ts };
    this.engine.localWrite("custom_objects", next, { baseUpdatedAt: row.updated_at });
    return next;
  }
}
