import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { schema } from './schema';
import { runMigrations } from './migrations';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'mission-control.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    console.log('[DB] Resolving database path...');
    console.log('[DB] DATABASE_PATH env:', process.env.DATABASE_PATH || '(not set)');
    console.log('[DB] Current working directory:', process.cwd());
    console.log('[DB] Resolved DB_PATH:', DB_PATH);

    const dbDir = path.dirname(DB_PATH);
    const dirExists = fs.existsSync(dbDir);
    console.log('[DB] Database directory:', dbDir, dirExists ? '(exists)' : '(MISSING)');

    if (!dirExists) {
      console.log('[DB] Creating database directory:', dbDir);
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const isNewDb = !fs.existsSync(DB_PATH);
    console.log('[DB] Database file exists:', !isNewDb);

    try {
      console.log('[DB] Opening database connection...');
      db = new Database(DB_PATH);
      console.log('[DB] Database connection opened successfully');
    } catch (error) {
      console.error('[DB] Failed to open database at:', DB_PATH, error);
      throw error;
    }

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log('[DB] Pragmas set (WAL mode, foreign keys ON)');

    // Initialize base schema (creates tables if they don't exist)
    try {
      console.log('[DB] Applying schema...');
      db.exec(schema);
      console.log('[DB] Schema applied successfully');
    } catch (error) {
      console.error('[DB] Failed to apply schema:', error);
      throw error;
    }

    // Run migrations for schema updates
    // This handles both new and existing databases
    try {
      console.log('[DB] Running migrations...');
      runMigrations(db);
      console.log('[DB] Migrations completed successfully');
    } catch (error) {
      console.error('[DB] Migration failed:', error);
      throw error;
    }

    if (isNewDb) {
      console.log('[DB] New database created at:', DB_PATH);
    } else {
      console.log('[DB] Existing database loaded from:', DB_PATH);
    }
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Type-safe query helpers
export function queryAll<T>(sql: string, params: unknown[] = []): T[] {
  const stmt = getDb().prepare(sql);
  return stmt.all(...params) as T[];
}

export function queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
  const stmt = getDb().prepare(sql);
  return stmt.get(...params) as T | undefined;
}

export function run(sql: string, params: unknown[] = []): Database.RunResult {
  const stmt = getDb().prepare(sql);
  return stmt.run(...params);
}

export function transaction<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}

// Export migration utilities for CLI use
export { runMigrations, getMigrationStatus } from './migrations';
