import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SEED_PRODUCTS } from './schema';

export type SqliteDb = DatabaseSync;

export function createDatabase(path = ':memory:'): SqliteDb {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_SQL);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO products (id, name, unit_price_paise, stock) VALUES (?, ?, ?, ?)',
  );
  for (const product of SEED_PRODUCTS) {
    insert.run(product.id, product.name, product.unitPricePaise, product.stock);
  }
  return db;
}

export function withImmediateTransaction<T>(db: SqliteDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Connection already aborted the transaction.
    }
    throw error;
  }
}
