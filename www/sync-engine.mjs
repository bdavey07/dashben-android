// PKM local-first sync engine (Phase 2, M1). Framework-free and
// transport-free: it works against any SQLite database object with
// exec/prepare (node:sqlite in tests, sql.js in desktop web,
// Capacitor SQLite on Android) and any transport object that speaks
// { snapshot, pull, push } like the server endpoints in
// custom-backend/sync-spec.md. No DOM, no fetch, no imports of app
// code, so this module can move across shells unchanged.

export const SYNC_TABLES = [
  "notes", "tasks", "people", "reading_items", "inbox_items", "projects",
  "custom_objects", "custom_object_types", "relations", "object_tags",
  "tag_vocab", "field_values", "ui_prefs", "attachments",
];

export const TABLE_COLUMNS = {
  notes: ["id", "title", "date", "type", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived"],
  tasks: ["id", "title", "done", "due_date", "priority", "project", "place", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived", "subtasks", "recurrence", "recurrence_group"],
  people: ["id", "title", "role", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived"],
  reading_items: ["id", "title", "url", "status", "source", "added", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived"],
  inbox_items: ["id", "title", "noted", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived"],
  projects: ["id", "title", "category", "status", "body_markdown", "body_version", "body_updated_at", "body_flags", "created_at", "updated_at", "archived", "subtasks"],
  custom_objects: ["id", "type", "title", "fields_json", "archived", "created_at", "updated_at"],
  custom_object_types: ["slug", "name", "fields_json", "has_tab", "created_at", "updated_at"],
  relations: ["from_type", "from_id", "to_type", "to_id", "relation_name"],
  object_tags: ["object_type", "object_id", "tag"],
  tag_vocab: ["id", "scope", "name"],
  field_values: ["object_type", "field", "value"],
  ui_prefs: ["key", "value", "updated_at"],
  attachments: ["id", "owner_type", "owner_id", "mime", "data", "name", "created_at", "updated_at", "archived"],
};

const COMPOSITE = new Set(["relations", "object_tags", "field_values"]);

export function idColumn(table) {
  if (table === "custom_object_types") return "slug";
  if (table === "ui_prefs") return "key";
  return "id";
}

export function rowIdFor(table, row) {
  if (table === "relations") return [row.from_type, row.from_id, row.to_type, row.to_id, row.relation_name].join("|");
  if (table === "object_tags") return [row.object_type, row.object_id, row.tag].join("|");
  if (table === "field_values") return [row.object_type, row.field, row.value].join("|");
  return String(row[idColumn(table)]);
}

function compositeWhere(table, rowId) {
  const parts = rowId.split("|");
  if (table === "relations") {
    if (parts.length !== 5) throw new Error(`Bad relations row_id: ${rowId}`);
    return { clause: "from_type=? AND from_id=? AND to_type=? AND to_id=? AND relation_name=?", vals: parts };
  }
  if (table === "object_tags") {
    if (parts.length !== 3) throw new Error(`Bad object_tags row_id: ${rowId}`);
    return { clause: "object_type=? AND object_id=? AND tag=?", vals: parts };
  }
  if (table === "field_values") {
    if (parts.length !== 3) throw new Error(`Bad field_values row_id: ${rowId}`);
    return { clause: "object_type=? AND field=? AND value=?", vals: parts };
  }
  throw new Error(`Table ${table} is not composite-keyed.`);
}

function cleanRow(table, row) {
  const allowed = TABLE_COLUMNS[table];
  if (!allowed) throw new Error(`Unknown sync table: ${table}`);
  const out = {};
  for (const c of allowed) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

function uid() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export class SyncEngine {
  constructor(db) {
    this.db = db;
  }

  // Nestable: localWrite calls txn itself, and set operations wrap
  // several localWrites in one txn for atomicity. Nested calls just
  // run inline inside the outer transaction.
  txn(fn) {
    if (this._depth > 0) return fn();
    this._depth = (this._depth ?? 0) + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this._depth = 0;
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      this._depth = 0;
      throw e;
    }
  }

  init(schemaSql) {
    this.db.exec(schemaSql);
    this.ensureConflictColumns();
  }

  // Reliability batch: sync_conflicts gained a local_row_json column
  // so a conflicted local edit survives (it used to exist only in the
  // outbox payload, which the conflict branch deletes). Databases
  // created before the column existed are never recreated from
  // schema.sql (CREATE TABLE IF NOT EXISTS does not alter), so add
  // the column in place wherever it is missing.
  ensureConflictColumns() {
    try {
      const cols = this.db.prepare("PRAGMA table_info(sync_conflicts)").all();
      if (cols.length && !cols.some((c) => c.name === "local_row_json")) {
        this.db.exec("ALTER TABLE sync_conflicts ADD COLUMN local_row_json TEXT");
      }
    } catch { /* sync_conflicts not created yet — the schema creates it with the column */ }
  }

  getWatermark() {
    const row = this.db.prepare("SELECT value FROM sync_meta WHERE key='seq'").get();
    return row ? Number(row.value) : 0;
  }

  setWatermark(seq) {
    this.db.prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('seq', ?)").run(String(seq));
  }

  // Full-table load for first launch. Rows replace local rows by key.
  applySnapshot(table, rows) {
    this.txn(() => {
      for (const row of rows) this.upsertLocal(table, cleanRow(table, row));
    });
  }

  upsertLocal(table, row) {
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const placeholders = cols.map(() => "?").join(", ");
    this.db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`).run(...cols.map((c) => row[c]));
  }

  deleteLocal(table, rowId) {
    if (COMPOSITE.has(table)) {
      const w = compositeWhere(table, rowId);
      this.db.prepare(`DELETE FROM ${table} WHERE ${w.clause}`).run(...w.vals);
    } else if (table === "tag_vocab") {
      this.db.prepare("DELETE FROM tag_vocab WHERE id=?").run(Number(rowId));
    } else {
      this.db.prepare(`DELETE FROM ${table} WHERE ${idColumn(table)}=?`).run(rowId);
    }
  }

  applyChanges(changes) {
    this.txn(() => {
      for (const c of changes) {
        if (c.op === "delete") this.deleteLocal(c.table, c.row_id);
        else if (c.row) this.upsertLocal(c.table, cleanRow(c.table, c.row));
      }
    });
  }

  // Every local write goes through here: the row change and its
  // outbox entry commit in one transaction, so a row can never exist
  // locally without a pending sync entry for it.
  localWrite(table, row, { baseUpdatedAt = null, op = "upsert" } = {}) {
    if (!SYNC_TABLES.includes(table)) throw new Error(`Unknown sync table: ${table}`);
    if (op === "delete" && !COMPOSITE.has(table) && table !== "tag_vocab") {
      throw new Error(`Delete is not supported for ${table}; archive with an upsert instead.`);
    }
    const clean = op === "delete" ? null : cleanRow(table, row);
    const rowId = op === "delete" ? String(row) : rowIdFor(table, clean);
    const changeId = uid();
    this.txn(() => {
      if (op === "delete") this.deleteLocal(table, rowId);
      else this.upsertLocal(table, clean);
      this.db.prepare(
        "INSERT INTO sync_outbox (client_change_id, table_name, row_id, op, base_updated_at, row_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(changeId, table, rowId, op, baseUpdatedAt, clean ? JSON.stringify(clean) : null, nowIso());
    });
    return { client_change_id: changeId, table, row_id: rowId, op, base_updated_at: baseUpdatedAt, row: clean };
  }

  outboxCount() {
    return this.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get().n;
  }

  listConflicts() {
    return this.db.prepare("SELECT * FROM sync_conflicts ORDER BY id DESC").all();
  }

  readLocalRow(table, rowId) {
    if (COMPOSITE.has(table)) {
      const w = compositeWhere(table, rowId);
      return this.db.prepare(`SELECT * FROM ${table} WHERE ${w.clause}`).get(...w.vals) ?? null;
    }
    if (table === "tag_vocab") {
      return this.db.prepare("SELECT * FROM tag_vocab WHERE id=?").get(Number(rowId)) ?? null;
    }
    return this.db.prepare(`SELECT * FROM ${table} WHERE ${idColumn(table)}=?`).get(rowId) ?? null;
  }

  dismissConflict(conflictId) {
    this.db.prepare("DELETE FROM sync_conflicts WHERE id=?").run(conflictId);
  }

  // Re-apply a conflicted local edit as a fresh edit on top of the
  // current server row: the stored local copy is queued through
  // localWrite with base = the server row's current updated_at, so
  // the next push applies instead of conflicting again. The conflict
  // record is consumed in the same transaction. Returns the queued
  // change, or null when there is nothing restorable (a conflict
  // recorded before local copies were preserved, or a delete).
  restoreConflict(conflictId) {
    const c = this.db.prepare("SELECT * FROM sync_conflicts WHERE id=?").get(conflictId);
    if (!c || !c.local_row_json) return null;
    let local = null;
    try { local = JSON.parse(c.local_row_json); } catch { return null; }
    if (!local || typeof local !== "object" || Array.isArray(local)) return null;
    let server = null;
    try { server = this.readLocalRow(c.table_name, c.row_id); } catch { server = null; }
    if (!server && c.server_row_json) {
      try { server = JSON.parse(c.server_row_json); } catch { server = null; }
    }
    const row = { ...local };
    if ((TABLE_COLUMNS[c.table_name] ?? []).includes("updated_at")) row.updated_at = nowIso();
    let change = null;
    this.txn(() => {
      change = this.localWrite(c.table_name, row, { baseUpdatedAt: server?.updated_at ?? null });
      this.db.prepare("DELETE FROM sync_conflicts WHERE id=?").run(conflictId);
    });
    return change;
  }

  // One sync cycle: pull first (reduces conflicts), then push the
  // outbox in order. Conflicts adopt the server row locally (server
  // wins by default) and are logged WITH the discarded local row, so
  // the edit survives in sync_conflicts until the user dismisses it
  // or restores it with restoreConflict(); the outbox entry is
  // dropped either way, because the server state is now the state
  // of record. Validation errors keep their entry for a later cycle
  // and are reported, never dropped.
  async sync(transport) {
    this.ensureConflictColumns();
    const report = { pulled: 0, applied: [], conflicts: [], errors: [] };
    const since = this.getWatermark();
    let cur = since;
    let hasMore = true;
    while (hasMore) {
      const page = await transport.pull(cur, 200);
      this.applyChanges(page.changes);
      report.pulled += page.changes.length;
      cur = page.next_seq;
      hasMore = page.has_more;
      this.txn(() => this.setWatermark(cur));
    }
    const outbox = this.db.prepare("SELECT * FROM sync_outbox ORDER BY rowid").all();
    if (outbox.length === 0) return report;
    // Coalesce per (table, row_id) before pushing. Push rows are full
    // snapshots, so only the latest state per row needs to go — and
    // pushing every intermediate edit self-conflicts: the server
    // stamps its own updated_at on each applied change, so edit 2's
    // base (the pre-edit-1 timestamp) never matches after edit 1
    // lands, and the engine would adopt the server row and drop
    // edit 2. The coalesced change carries the FIRST entry's base
    // (the server state as of pull) and the LAST entry's row/op, so
    // a batch of local edits to one row applies as a single change.
    // Group members share the outcome: applied/conflict drains them
    // all, an error keeps them all for retry.
    const groups = new Map();
    for (const o of outbox) {
      const key = `${o.table_name}\0${o.row_id}`;
      if (!groups.has(key)) groups.set(key, { first: o, last: o, members: [o] });
      else {
        const g = groups.get(key);
        g.last = o;
        g.members.push(o);
      }
    }
    const changes = [...groups.values()].map((g) => ({
      client_change_id: g.last.client_change_id,
      table: g.last.table_name,
      row_id: g.last.row_id,
      op: g.last.op,
      base_updated_at: g.first.base_updated_at,
      row: g.last.row_json ? JSON.parse(g.last.row_json) : null,
    }));
    const res = await transport.push(changes);
    // Re-pull to learn the server stamps on just-applied rows. The
    // server re-stamps updated_at on apply and returns no rows for
    // applied changes, and the watermark below jumps past those
    // changes — so without this, the next edit to an applied row
    // bases on the stale client timestamp and spuriously conflicts
    // (the pushed change is then dropped as "server row kept" even
    // though nobody else touched the row). Re-delivery is
    // idempotent: applyChanges upserts the server rows, adopting
    // their stamps. Stop once the post-push seq is covered;
    // anything newer waits for the next cycle. If the re-pull
    // itself fails, keep the pre-push watermark so the next cycle
    // re-delivers the applied rows instead of skipping them.
    let relearned = true;
    if ((res.applied ?? []).length > 0) {
      try {
        const target = res.seq ?? cur;
        let cur2 = cur;
        let more = true;
        while (more) {
          const page = await transport.pull(cur2, 200);
          this.applyChanges(page.changes);
          report.pulled += page.changes.length;
          cur2 = page.next_seq;
          more = page.has_more && cur2 < target;
        }
      } catch { relearned = false; }
    }
    const appliedSet = new Set(res.applied ?? []);
    const conflictById = new Map((res.conflicts ?? []).map((c) => [c.client_change_id, c]));
    const errorById = new Map((res.errors ?? []).map((e) => [e.client_change_id, e]));
    this.txn(() => {
      for (const g of groups.values()) {
        const o = g.last;
        const del = this.db.prepare("DELETE FROM sync_outbox WHERE client_change_id=?");
        if (appliedSet.has(o.client_change_id)) {
          for (const m of g.members) { del.run(m.client_change_id); report.applied.push(m.client_change_id); }
        } else if (conflictById.has(o.client_change_id)) {
          const c = conflictById.get(o.client_change_id);
          if (c.server_row) this.upsertLocal(o.table_name, cleanRow(o.table_name, c.server_row));
          this.db.prepare(
            "INSERT INTO sync_conflicts (client_change_id, table_name, row_id, server_row_json, local_row_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(o.client_change_id, o.table_name, o.row_id, c.server_row ? JSON.stringify(c.server_row) : null, g.last.row_json ?? null, nowIso());
          for (const m of g.members) { del.run(m.client_change_id); report.conflicts.push(m.client_change_id); }
        } else if (errorById.has(o.client_change_id)) {
          report.errors.push({ client_change_id: o.client_change_id, error: errorById.get(o.client_change_id).error });
        } else {
          report.errors.push({ client_change_id: o.client_change_id, error: "No result for change." });
        }
      }
      this.setWatermark(relearned ? (res.seq ?? cur) : cur);
    });
    return report;
  }

  // First-launch bootstrap: snapshot every table, then record the
  // seq from the FIRST snapshot call as the watermark. A change that
  // lands mid-bootstrap is then picked up by the next pull (re-apply
  // is idempotent), while a later seq could skip it forever.
  async firstSync(transport) {
    let seq = null;
    for (const table of SYNC_TABLES) {
      let cursor = null;
      for (;;) {
        const page = await transport.snapshot(table, cursor);
        this.applySnapshot(table, page.rows);
        if (seq === null) seq = page.seq;
        cursor = page.next_cursor;
        if (!cursor) break;
      }
    }
    const mark = seq ?? 0;
    this.txn(() => this.setWatermark(mark));
    return mark;
  }
}
