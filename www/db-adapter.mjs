// sql.js adapter: presents the node:sqlite-like interface the sync
// engine and local store expect (exec / prepare().run().get().all()),
// backed by a sql.js Database. Persistence is the caller's job: call
// exportBytes() after writes and restore with new SqlJsDb(SQL, bytes).
export class SqlJsDb {
  constructor(SQL, bytes = null) {
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
  }

  exec(sql) {
    this.db.exec(sql);
  }

  prepare(sql) {
    const db = this.db;
    return {
      run(...params) {
        const stmt = db.prepare(sql);
        try {
          stmt.run(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
          return { changes: db.getRowsModified() };
        } finally {
          stmt.free();
        }
      },
      get(...params) {
        const stmt = db.prepare(sql);
        try {
          stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
          return stmt.step() ? stmt.getAsObject() : null;
        } finally {
          stmt.free();
        }
      },
      all(...params) {
        const stmt = db.prepare(sql);
        const out = [];
        try {
          stmt.bind(params.length === 1 && Array.isArray(params[0]) ? params[0] : params);
          while (stmt.step()) out.push(stmt.getAsObject());
          return out;
        } finally {
          stmt.free();
        }
      },
    };
  }

  exportBytes() {
    return this.db.export();
  }
}
