// Both adapters execute the same SQL. Mutations are synchronous transactions:
// no asynchronous work is allowed between the capacity check and INSERT.
export function nodeStore(db) {
  return {
    all: (sql, ...args) => db.prepare(sql).all(...args),
    run: (sql, ...args) => db.prepare(sql).run(...args),
    transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
export function objectStore(storage) {
  return {
    all: (sql, ...args) => storage.sql.exec(sql, ...args).toArray(),
    run: (sql, ...args) => storage.sql.exec(sql, ...args),
    transaction: (fn) => storage.transactionSync(fn),
  };
}
export function migrate(store, sql, version = 1) {
  if (
    version > 1 &&
    store.all("SELECT version FROM schema_migrations WHERE version=?", version)
      .length
  )
    return;
  store.transaction(() => {
    for (const statement of sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      store.run(statement);
  });
}
