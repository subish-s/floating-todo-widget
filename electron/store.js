'use strict';

/**
 * Atomic, versioned JSON persistence for the desktop widget.
 *
 * Replaces raw `localStorage` + unguarded `writeFileSync` with a single
 * main-process store that:
 *  - writes atomically via temp-file + rename so crashes never truncate data,
 *  - maintains a rolling `.bak` snapshot and recovers from it if needed,
 *  - validates every loaded record and stamps a schema version, and
 *  - migrates legacy `output.json` files on first launch.
 */
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;

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

class TodoStore {
  /**
   * @param {string} userDataDir - `app.getPath('userData')`
   */
  constructor(userDataDir) {
    this.dir = userDataDir;
    this.primaryPath = path.join(userDataDir, 'tasks.v1.json');
    this.backupPath = path.join(userDataDir, 'tasks.v1.json.bak');
    this.legacyPath = path.join(userDataDir, 'output.json');
  }

  /**
   * Reads and validates todos from a file, supporting both the v1 envelope
   * `{ schemaVersion, updatedAt, todos }` and legacy raw arrays.
   * @param {string} filePath
   * @returns {object[] | null}
   */
  _readFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.todos)
          ? parsed.todos
          : null;
      if (!list) return null;
      return list.filter(isValidTodoRecord);
    } catch {
      return null;
    }
  }

  /**
   * Reads all stored todos (active + archived), recovering from `.bak` or
   * migrating `output.json` if necessary.
   * @returns {object[] | null} Null only when no store file exists yet.
   */
  _readAll() {
    const primary = this._readFile(this.primaryPath);
    if (primary !== null) return primary;

    const backup = this._readFile(this.backupPath);
    if (backup !== null) {
      this._writeAll(backup);
      return backup;
    }

    const legacy = this._readFile(this.legacyPath);
    if (legacy !== null) {
      this._writeAll(legacy);
      return legacy;
    }

    return null;
  }

  /**
   * Atomically persists the full list (active + archived) with a rolling `.bak`.
   * @param {object[]} allTodos
   * @returns {boolean}
   */
  _writeAll(allTodos) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });

      if (fs.existsSync(this.primaryPath)) {
        try {
          fs.copyFileSync(this.primaryPath, this.backupPath);
        } catch {
          // Best-effort backup; do not block saving primary data.
        }
      }

      const payload = JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          updatedAt: new Date().toISOString(),
          todos: allTodos,
        },
        null,
        2,
      );

      const tmpPath = `${this.primaryPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, payload, 'utf8');
      fs.renameSync(tmpPath, this.primaryPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Returns active (non-archived) todos, or `null` on a fresh install. */
  loadActiveTodos() {
    const all = this._readAll();
    if (all === null) return null;
    return all.filter((todo) => todo.archiveOnly !== true);
  }

  /** Replaces the active todo list while preserving archived records. */
  saveActiveTodos(activeTodos) {
    if (!Array.isArray(activeTodos)) return false;
    const all = this._readAll() ?? [];
    const archived = all.filter((todo) => todo.archiveOnly === true);
    const archivedIds = new Set(archived.map((todo) => todo.id));
    const sanitizedActive = activeTodos.filter(
      (todo) => isValidTodoRecord(todo) && !archivedIds.has(todo.id),
    );
    return this._writeAll([...sanitizedActive, ...archived]);
  }

  /** Moves expired/completed todos into the archive section of the store. */
  archiveTodos(todosToArchive) {
    if (!Array.isArray(todosToArchive)) return false;
    const all = this._readAll() ?? [];
    const archiveById = new Map(
      all.filter((todo) => todo.archiveOnly === true).map((todo) => [todo.id, todo]),
    );
    for (const todo of todosToArchive) {
      if (isValidTodoRecord(todo)) {
        archiveById.set(todo.id, { ...todo, archiveOnly: true });
      }
    }
    const archived = [...archiveById.values()];
    const archivedIds = new Set(archived.map((todo) => todo.id));
    const active = all.filter(
      (todo) => todo.archiveOnly !== true && !archivedIds.has(todo.id),
    );
    return this._writeAll([...active, ...archived]);
  }
}

module.exports = { TodoStore };
