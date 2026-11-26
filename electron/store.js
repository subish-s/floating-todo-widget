'use strict';

/**
 * Embedded SQLite persistence (via sql.js WASM) for the desktop widget.
 *
 * Replaces raw `localStorage` with a real relational SQLite database stored at
 * `<userData>/tasks.sqlite`:
 *  - Zero native C++ compilation (works out-of-the-box across Electron versions),
 *  - Transactional writes (`BEGIN` / `COMMIT` / `ROLLBACK`),
 *  - Atomic disk flush via temp-file + `renameSync` with rolling `.bak` recovery,
 *  - Automatic one-time migration from legacy `tasks.v1.json` / `output.json`.
 */
const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS store_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER,
    deadline INTEGER,
    hidden_at INTEGER,
    last_notified_at INTEGER,
    archive_only INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_todos_archive_only ON todos(archive_only);
`;

function isValidTodoRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'number' &&
    Number.isFinite(record.id) &&
    typeof record.text === 'string' &&
    typeof record.completed === 'boolean'
  );
}

function rowToTodo(row) {
  const todo = {
    id: Number(row.id),
    text: String(row.text),
    completed: Boolean(row.completed),
  };
  if (row.created_at !== null && row.created_at !== undefined) {
    todo.createdAt = Number(row.created_at);
  }
  if (row.deadline !== null && row.deadline !== undefined) {
    todo.deadline = Number(row.deadline);
  }
  if (row.hidden_at !== null && row.hidden_at !== undefined) {
    todo.hiddenAt = Number(row.hidden_at);
  }
  if (row.last_notified_at !== null && row.last_notified_at !== undefined) {
    todo.lastNotifiedAt = Number(row.last_notified_at);
  }
  return todo;
}

class TodoStore {
  /**
   * @param {string} userDataDir - `app.getPath('userData')`
   */
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.dbPath = path.join(userDataDir, 'tasks.sqlite');
    this.backupPath = path.join(userDataDir, 'tasks.sqlite.bak');
    this.legacyJsonPaths = [
      path.join(userDataDir, 'tasks.v1.json'),
      path.join(userDataDir, 'tasks.v1.json.bak'),
      path.join(userDataDir, 'output.json'),
    ];
    /** @type {import('sql.js').Database | null} */
    this.db = null;
    this._initPromise = null;
  }

  async init() {
    if (this.db) return;
    if (!this._initPromise) {
      this._initPromise = this._open();
    }
    await this._initPromise;
  }

  async _open() {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });

    const opened = this._tryOpenDbFile(SQL, this.dbPath) ?? this._tryOpenDbFile(SQL, this.backupPath);
    if (opened) {
      this.db = opened;
      this.db.run(SCHEMA_SQL);
      return;
    }

    this.db = new SQL.Database();
    this.db.run(SCHEMA_SQL);
    this._migrateLegacyJsonIfPresent();
  }

  _tryOpenDbFile(SQL, filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const buffer = fs.readFileSync(filePath);
      const db = new SQL.Database(new Uint8Array(buffer));
      // Quick integrity check to ensure the file is a valid SQLite database.
      db.exec('PRAGMA schema_version;');
      return db;
    } catch {
      return null;
    }
  }

  _migrateLegacyJsonIfPresent() {
    for (const jsonPath of this.legacyJsonPaths) {
      try {
        if (!fs.existsSync(jsonPath)) continue;
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        const list = Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)
            ? parsed.todos
            : null;
        if (!list) continue;
        const valid = list.filter(isValidTodoRecord);
        this._replaceAllInTx(valid);
        this._flushToDisk();
        return;
      } catch {
        // Try next legacy source.
      }
    }
  }

  _isInitialized() {
    const stmt = this.db.prepare("SELECT value FROM store_meta WHERE key = 'initialized'");
    try {
      return stmt.step() && stmt.getAsObject().value === '1';
    } finally {
      stmt.free();
    }
  }

  _markInitialized() {
    this.db.run(
      "INSERT INTO store_meta (key, value) VALUES ('initialized', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
    );
  }

  _upsertTodoStmt(stmt, todo, archiveOnly, now) {
    stmt.run([
      todo.id,
      todo.text,
      todo.completed ? 1 : 0,
      todo.createdAt ?? null,
      todo.deadline ?? null,
      todo.hiddenAt ?? null,
      todo.lastNotifiedAt ?? null,
      archiveOnly ? 1 : 0,
      now,
    ]);
  }

  _replaceAllInTx(records) {
    const now = Date.now();
    this.db.run('BEGIN TRANSACTION');
    try {
      this.db.run('DELETE FROM todos');
      const stmt = this.db.prepare(`
        INSERT INTO todos (id, text, completed, created_at, deadline, hidden_at, last_notified_at, archive_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const todo of records) {
          this._upsertTodoStmt(stmt, todo, todo.archiveOnly === true, now);
        }
      } finally {
        stmt.free();
      }
      this._markInitialized();
      this.db.run('COMMIT');
    } catch (err) {
      this.db.run('ROLLBACK');
      throw err;
    }
  }

  _flushToDisk() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      if (fs.existsSync(this.dbPath)) {
        try {
          fs.copyFileSync(this.dbPath, this.backupPath);
        } catch {
          // Best-effort backup; do not block primary flush.
        }
      }
      const data = Buffer.from(this.db.export());
      const tmpPath = `${this.dbPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, data);
      fs.renameSync(tmpPath, this.dbPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns active (non-archived) todos, or `null` on a fresh install. */
  async loadActiveTodos() {
    await this.init();
    if (!this._isInitialized()) return null;

    const stmt = this.db.prepare(
      'SELECT id, text, completed, created_at, deadline, hidden_at, last_notified_at FROM todos WHERE archive_only = 0 ORDER BY id ASC',
    );
    const results = [];
    try {
      while (stmt.step()) {
        results.push(rowToTodo(stmt.getAsObject()));
      }
    } finally {
      stmt.free();
    }
    return results;
  }

  /** Replaces the active todo list in a transaction while preserving archived rows. */
  async saveActiveTodos(activeTodos) {
    if (!Array.isArray(activeTodos)) return false;
    await this.init();
    const now = Date.now();

    this.db.run('BEGIN TRANSACTION');
    try {
      const archivedIds = new Set();
      const archivedStmt = this.db.prepare('SELECT id FROM todos WHERE archive_only = 1');
      try {
        while (archivedStmt.step()) {
          archivedIds.add(Number(archivedStmt.getAsObject().id));
        }
      } finally {
        archivedStmt.free();
      }

      this.db.run('DELETE FROM todos WHERE archive_only = 0');

      const insertStmt = this.db.prepare(`
        INSERT INTO todos (id, text, completed, created_at, deadline, hidden_at, last_notified_at, archive_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      try {
        for (const todo of activeTodos) {
          if (isValidTodoRecord(todo) && !archivedIds.has(todo.id)) {
            this._upsertTodoStmt(insertStmt, todo, false, now);
          }
        }
      } finally {
        insertStmt.free();
      }

      this._markInitialized();
      this.db.run('COMMIT');
      return this._flushToDisk();
    } catch {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback error if no transaction is active.
      }
      return false;
    }
  }

  /** Moves expired/completed todos into the archive section of the SQLite table. */
  async archiveTodos(todosToArchive) {
    if (!Array.isArray(todosToArchive)) return false;
    await this.init();
    const now = Date.now();

    this.db.run('BEGIN TRANSACTION');
    try {
      const upsertStmt = this.db.prepare(`
        INSERT INTO todos (id, text, completed, created_at, deadline, hidden_at, last_notified_at, archive_only, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text,
          completed = excluded.completed,
          created_at = excluded.created_at,
          deadline = excluded.deadline,
          hidden_at = excluded.hidden_at,
          last_notified_at = excluded.last_notified_at,
          archive_only = 1,
          updated_at = excluded.updated_at
      `);
      try {
        for (const todo of todosToArchive) {
          if (isValidTodoRecord(todo)) {
            this._upsertTodoStmt(upsertStmt, todo, true, now);
          }
        }
      } finally {
        upsertStmt.free();
      }

      this._markInitialized();
      this.db.run('COMMIT');
      return this._flushToDisk();
    } catch {
      try {
        this.db.run('ROLLBACK');
      } catch {
        // Ignore rollback error if no transaction is active.
      }
      return false;
    }
  }
}

module.exports = { TodoStore };
