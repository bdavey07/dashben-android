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

// Composite row ids URI-encode each component (reliability round
// 2): a component containing "|" (a tag named "a|b") used to produce
// an id no parser could split back. compositeWhere decodes with a
// raw fallback, so ids written before this change still resolve.
const encPart = (v) => encodeURIComponent(String(v ?? ""));
const decPart = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

export function rowIdFor(table, row) {
  if (table === "relations") return [row.from_type, row.from_id, row.to_type, row.to_id, row.relation_name].map(encPart).join("|");
  if (table === "object_tags") return [row.object_type, row.object_id, row.tag].map(encPart).join("|");
  if (table === "field_values") return [row.object_type, row.field, row.value].map(encPart).join("|");
  return String(row[idColumn(table)]);
}

function compositeWhere(table, rowId) {
  const parts = rowId.split("|").map(decPart);
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

// Per-table {count, rev} for the lightweight health check. The rev
// algorithm (djb2 over sorted rowId/updated_at/archived entries)
// mirrors the server counts route exactly — keep them in lockstep.
export function localTableCounts(db) {
  const out = {};
  for (const table of SYNC_TABLES) {
    const cols = TABLE_COLUMNS[table] ?? [];
    const wanted = [];
    if (table === "relations") wanted.push("from_type", "from_id", "to_type", "to_id", "relation_name");
    else if (table === "object_tags") wanted.push("object_type", "object_id", "tag");
    else if (table === "field_values") wanted.push("object_type", "field", "value");
    else if (table === "ui_prefs") wanted.push("key");
    else if (table === "custom_object_types") wanted.push("slug");
    else wanted.push("id");
    if (cols.includes("updated_at")) wanted.push("updated_at");
    if (cols.includes("archived")) wanted.push("archived");
    const sel = wanted.filter((c) => cols.includes(c));
    let rows = [];
    try { rows = db.prepare(`SELECT ${sel.join(", ")} FROM ${table}`).all(); } catch { rows = []; }
    const entries = rows.map((r) => `${rowIdFor(table, r)}\u0001${String(r.updated_at ?? "")}\u0001${String(r.archived ?? "")}`);
    entries.sort();
    let h = 5381;
    const s = entries.join("\u0002");
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    out[table] = { count: rows.length, rev: h.toString(16) };
  }
  return out;
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

  // Rows with queued local edits are protected from pulled changes
  // (review 3, item 2): a pull — including the post-push re-pull —
  // must never overwrite a row the user has edited but not yet
  // synced, or the display reverts and the queued edit self-conflicts
  // on its stale base next cycle. `excludeIds` names outbox entries
  // already accounted for by an in-flight push (their rows SHOULD
  // adopt the server stamps the re-pull delivers); any OTHER queued
  // entry guards its row. When the guarded row's incoming change is
  // EXACTLY this push's acknowledged server row for it (appliedRows,
  // review 5 item 2), it is our own edit coming back: rebase the
  // queued entries onto its server stamp and re-assert the queued
  // snapshot, so the newer edit stays visible and pushes cleanly
  // next cycle. A FOREIGN change to a guarded row is held entirely
  // — same key is not proof of authorship.
  applyChanges(changes, opts = {}) {
    const exclude = opts.excludeIds ?? null;
    const appliedRows = opts.appliedRows ?? null;
    this.txn(() => {
      let guard = null;
      const guardSet = () => {
        if (guard) return guard;
        guard = new Set();
        for (const r of this.db.prepare("SELECT client_change_id, table_name, row_id FROM sync_outbox").all()) {
          if (exclude && exclude.has(r.client_change_id)) continue;
          guard.add(r.table_name + "\0" + r.row_id);
        }
        return guard;
      };
      for (const c of changes) {
        const key = c.table + "\0" + c.row_id;
        if (guardSet().has(key)) {
          if (appliedRows && c.op !== "delete" && c.row) {
            const acked = appliedRows.get(key);
            if (acked !== undefined && acked === JSON.stringify(cleanRow(c.table, c.row))) {
              this.db.prepare("UPDATE sync_outbox SET base_updated_at=? WHERE table_name=? AND row_id=?")
                .run(c.row.updated_at ?? null, c.table, c.row_id);
              this.reassertPending(c.table, c.row_id);
            }
          }
          continue;
        }
        if (c.op === "delete") this.deleteLocal(c.table, c.row_id);
        else if (c.row) this.upsertLocal(c.table, cleanRow(c.table, c.row));
      }
    });
  }

  // Re-apply the newest queued snapshot for a row over whatever a
  // bulk apply (pull page, snapshot) put there, so a pending edit is
  // what the user sees. Bases are NOT touched here — a genuinely
  // diverged server row still conflicts honestly at push time.
  reassertPending(table, rowId) {
    const last = this.db.prepare("SELECT op, row_json FROM sync_outbox WHERE table_name=? AND row_id=? ORDER BY rowid DESC LIMIT 1").get(table, rowId);
    if (!last) return;
    if (last.op === "delete") this.deleteLocal(table, rowId);
    else if (last.row_json) this.upsertLocal(table, cleanRow(table, JSON.parse(last.row_json)));
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
    // Delete callers may pass the row object instead of a pre-joined
    // id string: the encoded id is then computed here, so components
    // containing "|" (a tag named "a|b") survive — raw template
    // strings used to throw in the id parser (review 3, item 7).
    // Plain string ids still work (legacy unencoded ids parse too).
    const rowId = op === "delete"
      ? (row !== null && typeof row === "object" ? rowIdFor(table, row) : String(row))
      : rowIdFor(table, clean);
    const changeId = uid();
    this.txn(() => {
      if (table !== "ui_prefs") {
        let prev = null;
        try { prev = this.readLocalRow(table, rowId); } catch { prev = null; }
        if (prev && (op === "delete" || JSON.stringify(prev) !== JSON.stringify(clean))) this.captureHistory(table, rowId, op, prev);
      }
      if (op === "delete") this.deleteLocal(table, rowId);
      else this.upsertLocal(table, clean);
      this.db.prepare(
        "INSERT INTO sync_outbox (client_change_id, table_name, row_id, op, base_updated_at, row_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(changeId, table, rowId, op, baseUpdatedAt, clean ? JSON.stringify(clean) : null, nowIso());
    });
    return { client_change_id: changeId, table, row_id: rowId, op, base_updated_at: baseUpdatedAt, row: clean };
  }


  // --- Recovery history (feature batch): every localWrite keeps the
  // pre-change row in a local-only row_history table (capped per row
  // and globally), so deleted items and previous versions can be
  // restored from Management. Sync-applied changes do not pass
  // through localWrite, so history reflects THIS device's edits.
  ensureHistorySchema() {
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS row_history (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL, row_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_row_history_row ON row_history(table_name, row_id);`);
    } catch { /* schema.sql creates it on fresh databases */ }
  }

  captureHistory(table, rowId, op, prevRow) {
    if (!prevRow || table === "ui_prefs") return;
    try {
      this.ensureHistorySchema();
      this.db.prepare("INSERT INTO row_history (table_name, row_id, op, row_json, created_at) VALUES (?, ?, ?, ?, ?)").run(table, rowId, op, JSON.stringify(prevRow), nowIso());
      this.db.prepare("DELETE FROM row_history WHERE table_name=? AND row_id=? AND id NOT IN (SELECT id FROM row_history WHERE table_name=? AND row_id=? ORDER BY id DESC LIMIT 25)").run(table, rowId, table, rowId);
      this.db.prepare("DELETE FROM row_history WHERE id NOT IN (SELECT id FROM row_history ORDER BY id DESC LIMIT 2000)").run();
    } catch { /* history is best-effort */ }
  }

  listHistory(limit = 100) {
    this.ensureHistorySchema();
    return this.db.prepare("SELECT * FROM row_history ORDER BY id DESC LIMIT ?").all(limit);
  }

  restoreHistory(historyId) {
    this.ensureHistorySchema();
    const h = this.db.prepare("SELECT * FROM row_history WHERE id=?").get(historyId);
    if (!h) return null;
    let prev = null;
    try { prev = JSON.parse(h.row_json); } catch { prev = null; }
    if (!prev) return null;
    let current = null;
    try { current = this.readLocalRow(h.table_name, h.row_id); } catch { current = null; }
    const row = { ...prev };
    if ((TABLE_COLUMNS[h.table_name] ?? []).includes("updated_at")) row.updated_at = nowIso();
    let change = null;
    this.txn(() => {
      change = this.localWrite(h.table_name, row, { baseUpdatedAt: current?.updated_at ?? null });
      this.db.prepare("DELETE FROM row_history WHERE id=?").run(historyId);
    });
    return change;
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
    this.ensureHistorySchema();
    const report = { pulled: 0, applied: [], conflicts: [], errors: [] };
    const since = this.getWatermark();
    let cur = since;
    let hasMore = true;
    while (hasMore) {
      const page = await transport.pull(cur, 200);
      if (page.resync) {
        // The server pruned change entries this client still needed
        // (retention). Rebuild from a full snapshot, then continue
        // to the push phase with the snapshot watermark.
        await this.firstSync(transport);
        report.resynced = true;
        cur = this.getWatermark();
        break;
      }
      this.applyChanges(page.changes);
      report.pulled += page.changes.length;
      cur = page.next_seq;
      hasMore = page.has_more;
      this.txn(() => this.setWatermark(cur));
    }
    const outbox = this.db.prepare("SELECT * FROM sync_outbox ORDER BY rowid").all();
    if (outbox.length === 0) return report;
    const pushedIds = new Set(outbox.map((o) => o.client_change_id));
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
    // The watermark may only advance over changes actually DELIVERED
    // by a pull (review 3, item 3): res.seq is the server's head, and
    // adopting it when nothing applied (every change errored or
    // conflicted, so the re-pull below is skipped) would jump past
    // server changes this client has never seen.
    // Exact acknowledgements for the re-pull (review 5, item 2):
    // row key -> the acknowledged server row (cleaned JSON). Older
    // servers return no applied_rows; the map is then empty and NO
    // rebasing happens — queued edits conflict honestly next cycle
    // instead of risking a silent overwrite.
    const appliedRows = new Map();
    for (const ar of res.applied_rows ?? []) {
      if (ar?.server_row) appliedRows.set(ar.table + "\0" + ar.row_id, JSON.stringify(cleanRow(ar.table, ar.server_row)));
    }
    let deliveredMark = cur;
    if ((res.applied ?? []).length > 0) {
      try {
        const target = res.seq ?? cur;
        let cur2 = cur;
        let more = true;
        while (more) {
          const page = await transport.pull(cur2, 200);
          this.applyChanges(page.changes, { excludeIds: pushedIds, appliedRows });
          report.pulled += page.changes.length;
          cur2 = page.next_seq;
          more = page.has_more && cur2 < target;
        }
        deliveredMark = cur2;
      } catch { deliveredMark = cur; }
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
          // Adopt the acknowledged server row (review 6, item 5):
          // when a push response is lost, the retry's receipt
          // replay reports "applied" but the change's seq is
          // already behind the watermark, so no pull will ever
          // deliver the server stamp — without adopting the ack
          // here, the local row keeps its stale timestamp and the
          // next edit conflicts against this device's own earlier
          // write. If newer edits queued during the push, rebase
          // them onto the ack and re-assert their snapshot instead
          // (the re-pull's ack path remains as a fallback).
          const ackJson = appliedRows.get(o.table_name + "\0" + o.row_id);
          if (ackJson !== undefined) {
            try {
              const ackRow = JSON.parse(ackJson);
              const remaining = this.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name=? AND row_id=?").get(o.table_name, o.row_id).n;
              if (remaining === 0) {
                this.upsertLocal(o.table_name, ackRow);
              } else {
                this.db.prepare("UPDATE sync_outbox SET base_updated_at=? WHERE table_name=? AND row_id=?").run(ackRow.updated_at ?? null, o.table_name, o.row_id);
                this.reassertPending(o.table_name, o.row_id);
              }
            } catch { /* keep the local row; the next cycle heals */ }
          }
        } else if (conflictById.has(o.client_change_id)) {
          const c = conflictById.get(o.client_change_id);
          if (c.server_row) this.upsertLocal(o.table_name, cleanRow(o.table_name, c.server_row));
          this.db.prepare(
            "INSERT INTO sync_conflicts (client_change_id, table_name, row_id, server_row_json, local_row_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(o.client_change_id, o.table_name, o.row_id, c.server_row ? JSON.stringify(c.server_row) : null, g.last.row_json ?? null, nowIso());
          for (const m of g.members) { del.run(m.client_change_id); report.conflicts.push(m.client_change_id); }
          // A newer edit queued DURING the push is not a group
          // member and survives in the outbox; re-assert its
          // snapshot so the visible row stays the user's draft
          // instead of reverting to the server copy (review 5,
          // item 3). The conflict record above keeps the submitted
          // version for the recovery UI.
          this.reassertPending(o.table_name, o.row_id);
        } else if (errorById.has(o.client_change_id)) {
          report.errors.push({ client_change_id: o.client_change_id, error: errorById.get(o.client_change_id).error });
        } else {
          report.errors.push({ client_change_id: o.client_change_id, error: "No result for change." });
        }
      }
      // tag_vocab id adoption (round 2): the server adopted or
      // assigned a real id for a temp negative-id vocab row. The
      // re-pull above already delivered the server row under its
      // real id, so drop the temp row and point any still-queued
      // changes and conflicts at the adopted id.
      for (const r of res.remapped ?? []) {
        if (r.table !== "tag_vocab" || !r.server_row) continue;
        const fromId = String(r.from_row_id);
        const toId = String(r.server_row.id);
        if (fromId === toId) continue;
        this.db.prepare("DELETE FROM tag_vocab WHERE id=?").run(Number(fromId));
        const pend = this.db.prepare("SELECT client_change_id, row_json FROM sync_outbox WHERE table_name='tag_vocab' AND row_id=?").all(fromId);
        for (const p2 of pend) {
          let rj = null;
          try { rj = p2.row_json ? JSON.parse(p2.row_json) : null; } catch { rj = null; }
          if (rj && typeof rj === "object") rj.id = r.server_row.id;
          this.db.prepare("UPDATE sync_outbox SET row_id=?, row_json=? WHERE client_change_id=?")
            .run(toId, rj ? JSON.stringify(rj) : p2.row_json, p2.client_change_id);
        }
        this.db.prepare("UPDATE sync_conflicts SET row_id=? WHERE table_name='tag_vocab' AND row_id=?").run(toId, fromId);
      }
      this.setWatermark(deliveredMark);
    });
    return report;
  }

  // First-launch bootstrap: snapshot every table, then record the
  // seq from the FIRST snapshot call as the watermark. A change that
  // lands mid-bootstrap is then picked up by the next pull (re-apply
  // is idempotent), while a later seq could skip it forever.
  // Snapshot replacement (review 4, item 9a): applySnapshot only
  // upserts, so without pruning, a row deleted server-side survived
  // every Re-download / pruning resync in the hard-deletable tables
  // (tags, relations, field values, vocab). Delete local rows the
  // snapshot does not contain — except rows with queued local
  // edits, which the push phase still has to resolve.
  pruneStaleRows(table, seenIds) {
    this.txn(() => {
      const pending = new Set(this.db.prepare("SELECT row_id FROM sync_outbox WHERE table_name=?").all(table).map((r) => String(r.row_id)));
      let localIds;
      if (COMPOSITE.has(table)) {
        localIds = this.db.prepare(`SELECT * FROM ${table}`).all().map((r) => rowIdFor(table, r));
      } else {
        const col = idColumn(table);
        localIds = this.db.prepare(`SELECT ${col} AS id FROM ${table}`).all().map((r) => String(r.id));
      }
      for (const id of localIds) {
        if (!seenIds.has(id) && !pending.has(id)) this.deleteLocal(table, id);
      }
    });
  }

  async firstSync(transport) {
    let seq = null;
    for (const table of SYNC_TABLES) {
      let cursor = null;
      const seen = new Set();
      for (;;) {
        const page = await transport.snapshot(table, cursor);
        this.applySnapshot(table, page.rows);
        for (const r of page.rows) seen.add(rowIdFor(table, r));
        if (seq === null) seq = page.seq;
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      this.pruneStaleRows(table, seen);
      // Re-assert this table's queued edits immediately (review 6,
      // item 4): the whole-snapshot restoration at the end covers
      // the happy path, but if a LATER table's download fails, the
      // tables already processed must not be left showing server
      // copies over the user's queued drafts.
      const pendTables = this.db.prepare("SELECT DISTINCT row_id FROM sync_outbox WHERE table_name=?").all(table);
      for (const p2 of pendTables) this.reassertPending(table, String(p2.row_id));
    }
    // A snapshot rebuild must not bury queued local edits (review 3,
    // item 2): re-assert every pending row over the snapshot state.
    this.txn(() => {
      const keys = this.db.prepare("SELECT DISTINCT table_name, row_id FROM sync_outbox").all();
      for (const k of keys) this.reassertPending(k.table_name, k.row_id);
    });
    const mark = seq ?? 0;
    this.txn(() => this.setWatermark(mark));
    return mark;
  }
}
