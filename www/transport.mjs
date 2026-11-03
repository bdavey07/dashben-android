// Transports for the M3 client. HttpTransport speaks the real Phase 1
// endpoints. FakeTransport is an in-memory server for demo mode: it
// mirrors the server's conflict rule so the offline proof works with
// no token and no network.

export class HttpTransport {
  constructor(base, token) {
    this.base = base.replace(/\/$/, "");
    this.token = token;
  }

  async snapshot(table, cursor) {
    const q = new URLSearchParams({ table, limit: "500" });
    if (cursor) q.set("cursor", cursor);
    const r = await fetch(`${this.base}/api/sync/snapshot?${q}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`snapshot ${table} -> ${r.status}`);
    return r.json();
  }

  async pull(since, limit) {
    const r = await fetch(`${this.base}/api/sync/pull?since=${since}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`pull -> ${r.status}`);
    return r.json();
  }

  async push(changes) {
    const r = await fetch(`${this.base}/api/sync/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ changes }),
    });
    if (!r.ok) throw new Error(`push -> ${r.status}`);
    return r.json();
  }
}

import { rowIdFor, SYNC_TABLES } from "./sync-engine.mjs";

export class FakeTransport {
  constructor() {
    this.tables = {};
    for (const t of SYNC_TABLES) this.tables[t] = new Map();
    this.log = [];
    this.calls = [];
  }

  seed(table, row) {
    this.tables[table].set(rowIdFor(table, row), { ...row });
  }

  async snapshot(table, cursor) {
    this.calls.push(`snapshot:${table}`);
    return { rows: [...this.tables[table].values()], next_cursor: null, seq: this.log.length };
  }

  async pull(since, limit) {
    this.calls.push("pull");
    const page = this.log.filter((c) => c.seq > since).slice(0, limit);
    return {
      changes: page,
      next_seq: page.length ? page[page.length - 1].seq : since,
      has_more: this.log.filter((c) => c.seq > since).length > limit,
    };
  }

  async push(changes) {
    this.calls.push("push");
    const applied = [], conflicts = [], errors = [];
    for (const ch of changes) {
      if (!SYNC_TABLES.includes(ch.table)) {
        errors.push({ client_change_id: ch.client_change_id, error: `Unknown table ${ch.table}` });
        continue;
      }
      if (ch.op === "delete") {
        if (["relations", "object_tags", "field_values", "tag_vocab"].includes(ch.table)) {
          this.tables[ch.table].delete(ch.row_id);
          this.log.push({ seq: this.log.length + 1, table: ch.table, row_id: ch.row_id, op: "delete", row: null });
          applied.push(ch.client_change_id);
        } else {
          errors.push({ client_change_id: ch.client_change_id, error: `Delete not supported for ${ch.table}` });
        }
        continue;
      }
      const row = { ...ch.row };
      const id = rowIdFor(ch.table, row);
      const server = this.tables[ch.table].get(id);
      if (server && server.updated_at !== undefined && ch.base_updated_at !== null && ch.base_updated_at !== undefined && server.updated_at !== ch.base_updated_at) {
        conflicts.push({ client_change_id: ch.client_change_id, table: ch.table, row_id: ch.row_id, server_row: { ...server } });
        continue;
      }
      if (server && row.body_markdown !== undefined && row.body_markdown !== server.body_markdown) {
        row.body_version = (server.body_version ?? 0) + 1;
      }
      if (row.updated_at !== undefined) row.updated_at = new Date().toISOString();
      this.tables[ch.table].set(id, row);
      this.log.push({ seq: this.log.length + 1, table: ch.table, row_id: ch.row_id, op: "upsert", row: { ...row } });
      applied.push(ch.client_change_id);
    }
    return { applied, conflicts, errors, seq: this.log.length };
  }
}

export function demoSeed(fake) {
  const ts = "2026-11-02T12:00:00.000Z";
  fake.seed("tasks", { id: "demo-t1", title: "Buy milk", done: 0, due_date: "2026-11-02", priority: "P2", project: "Home", place: null, body_markdown: "", body_version: 0, body_updated_at: null, body_flags: "[]", created_at: ts, updated_at: ts, archived: 0, subtasks: JSON.stringify([{ id: "s1", text: "Oat milk", done: 0 }]), recurrence: "", recurrence_group: null });
  fake.seed("tasks", { id: "demo-t2", title: "Weekday standup notes", done: 0, due_date: "2026-11-02", priority: "P1", project: "General", place: null, body_markdown: "", body_version: 0, body_updated_at: null, body_flags: "[]", created_at: ts, updated_at: ts, archived: 0, subtasks: "[]", recurrence: JSON.stringify({ freq: "weekly", interval: 1, weekdays: [1, 2, 3, 4, 5], endDate: null, dayOfMonth: null }), recurrence_group: "demo-g1" });
  fake.seed("notes", { id: "demo-n1", title: "Demo note", date: "2026-11-02", type: "General Notes", body_markdown: "This note lives in the local database. Edit it offline and sync later.", body_version: 1, body_updated_at: ts, body_flags: "[]", created_at: ts, updated_at: ts, archived: 0 });
  fake.seed("inbox_items", { id: "demo-i1", title: "Captured idea", noted: null, body_markdown: "An inbox item waiting for triage.", body_version: 1, body_updated_at: ts, body_flags: "[]", created_at: ts, updated_at: ts, archived: 0 });
  fake.seed("people", { id: "demo-p1", title: "Demo Person", role: "Personal contact", body_markdown: "", body_version: 0, body_updated_at: null, body_flags: "[]", created_at: ts, updated_at: ts, archived: 0 });
}
