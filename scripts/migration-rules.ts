/**
 * Static rules every ALKAO migration must satisfy (frozen):
 *   * A public table is created only together with ENABLE ROW LEVEL SECURITY in the
 *     same migration file.
 *   * Public tables are named ticketing_*.
 *   * No write policies (INSERT/UPDATE/DELETE/ALL), no policy or grant for anon/PUBLIC,
 *     and RLS is never disabled.
 */
export function checkMigrationSql(file: string, sql: string): string[] {
  const problems: string[] = [];
  const code = stripComments(sql);

  const tableRe = /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi;
  for (const m of code.matchAll(tableRe)) {
    const schema = (m[1] ?? "public").toLowerCase();
    const table = m[2]!.toLowerCase();
    if (schema !== "public") continue;
    if (!table.startsWith("ticketing_")) {
      problems.push(`${file}: public table "${table}" must be named ticketing_*`);
    }
    const rls = new RegExp(
      `\\balter\\s+table\\s+(?:only\\s+)?(?:"?public"?\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`,
      "i",
    );
    if (!rls.test(code)) {
      problems.push(`${file}: table "${table}" is created without ENABLE ROW LEVEL SECURITY in the same migration`);
    }
  }

  if (/\bdisable\s+row\s+level\s+security\b/i.test(code)) {
    problems.push(`${file}: DISABLE ROW LEVEL SECURITY is forbidden`);
  }
  for (const m of code.matchAll(/\bcreate\s+policy\b[\s\S]*?;/gi)) {
    const stmt = m[0];
    if (/\bfor\s+(insert|update|delete|all)\b/i.test(stmt) || !/\bfor\s+select\b/i.test(stmt)) {
      problems.push(`${file}: only FOR SELECT policies are allowed: ${oneLine(stmt)}`);
    }
    if (/\bto\s+[^;]*\b(anon|public)\b/i.test(stmt.replace(/\bon\s+public\.\w+/gi, ""))) {
      problems.push(`${file}: policies must not target anon or PUBLIC: ${oneLine(stmt)}`);
    }
  }
  for (const m of code.matchAll(/\bgrant\b[\s\S]*?;/gi)) {
    const stmt = m[0];
    const to = /\bto\s+([\s\S]*?);/i.exec(stmt)?.[1] ?? "";
    if (/\b(anon|public)\b/i.test(to)) {
      problems.push(`${file}: grants to anon or PUBLIC are forbidden: ${oneLine(stmt)}`);
    }
    if (/\bto\s+[\s\S]*\bauthenticated\b/i.test(stmt) && /\bgrant\s+(?!select\b|usage\b|execute\b)/i.test(stmt)) {
      problems.push(`${file}: authenticated may only receive SELECT/USAGE/EXECUTE: ${oneLine(stmt)}`);
    }
  }
  return problems;
}

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}
