import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// int8 / count(*) as JS numbers: ALKAO counters and amounts stay far below 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createPool(connectionString: string, max = 10): Db {
  return new pg.Pool({ connectionString, max });
}

export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
