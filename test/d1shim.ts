// Minimal D1 shim on node:sqlite for tests.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// vite can't resolve node:sqlite yet, so load it via require
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function makeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  // Each first/all/run, and each batch, is one call to D1. A Worker invocation may make at most 1000
  // (paid plan), so tests can check bulk paths stay well under it.
  const counter = { calls: 0 };
  const exec = (sql: string, args: unknown[]) => {
    const r = db.prepare(sql).run(...(args as never[]));
    return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const stmt = (sql: string, args: unknown[] = []) => ({
    sql,
    args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => (counter.calls++, (db.prepare(sql).get(...(args as never[])) as T) ?? null),
    all: async <T>() => (counter.calls++, { results: db.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => (counter.calls++, exec(sql, args)),
  });
  return {
    raw: db,
    counter,
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: ReturnType<typeof stmt>[]) => (counter.calls++, stmts.map((s) => exec(s.sql, s.args))),
  };
}
