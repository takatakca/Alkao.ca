import { describe, expect, it } from "vitest";
import { listMigrations } from "../../src/db/migrate.js";
import { checkMigrationSql } from "../../scripts/migration-rules.js";

describe("migration rules", () => {
  it("accepts every committed migration", () => {
    for (const m of listMigrations()) expect(checkMigrationSql(m.name, m.sql), m.name).toEqual([]);
  });

  it("rejects a table created without RLS in the same migration", () => {
    expect(checkMigrationSql("x.sql", "CREATE TABLE public.ticketing_x (id int);")).toHaveLength(1);
    expect(checkMigrationSql("x.sql", "CREATE TABLE ticketing_x (id int); -- ALTER TABLE ticketing_x ENABLE ROW LEVEL SECURITY;")).toHaveLength(1);
    expect(
      checkMigrationSql("x.sql", "CREATE TABLE IF NOT EXISTS public.ticketing_x (id int);\nALTER TABLE public.ticketing_x ENABLE ROW LEVEL SECURITY;"),
    ).toEqual([]);
  });

  it("rejects public tables outside the ticketing_ namespace", () => {
    expect(checkMigrationSql("x.sql", "CREATE TABLE public.orders (id int); ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;")).toHaveLength(1);
    expect(checkMigrationSql("x.sql", "CREATE TABLE alkao_private.notes (id int);")).toEqual([]);
  });

  it("rejects write policies, anon policies, anon grants and disabling RLS", () => {
    expect(checkMigrationSql("x.sql", "CREATE POLICY p ON public.ticketing_x FOR ALL TO authenticated USING (true);")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "CREATE POLICY p ON public.ticketing_x FOR INSERT TO authenticated WITH CHECK (true);")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "CREATE POLICY p ON public.ticketing_x FOR SELECT TO anon USING (true);")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "GRANT SELECT ON public.ticketing_x TO anon;")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "GRANT INSERT ON public.ticketing_x TO authenticated;")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "ALTER TABLE public.ticketing_x DISABLE ROW LEVEL SECURITY;")).not.toEqual([]);
    expect(checkMigrationSql("x.sql", "CREATE POLICY p ON public.ticketing_x FOR SELECT TO authenticated USING (true);")).toEqual([]);
  });
});
