/**
 * Run 63: is a public ALKAO address up? GET only, nothing secret: the service and its
 * database answer, and so does the home page. Run every 3 hours by the "Live" workflow, whose
 * failure is GitHub's e-mail to the owner. Messages in French, like check:golive.
 *
 * Unlike check:golive --url, settings still waiting for the owner (Stripe, /metrics) are
 * not failures here: only an address that stopped answering is.
 */
export interface LiveWatch {
  origin: string;
  ok: boolean;
  /** The commit /health names (Run 62), when the deployment sets it. */
  build: string | null;
  lines: string[];
}

export async function watchAddress(
  origin: string,
  { doFetch = fetch, expectBuild, requireBuild = false, timeoutMs = 10_000 }: { doFetch?: typeof fetch; expectBuild?: string; requireBuild?: boolean; timeoutMs?: number } = {},
): Promise<LiveWatch> {
  const lines: string[] = [];
  let ok = true;
  const bad = (line: string) => {
    ok = false;
    lines.push(`✘ ${line}`);
  };
  const get = (path: string) =>
    doFetch(`${origin}${path}`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  const json = async (r: Response) => (await r.json().catch(() => null)) as Record<string, unknown> | null;

  const health = await get("/health");
  const h = health ? await json(health) : null;
  if (!health) {
    bad("injoignable (DNS, certificat ou serveur)");
    return { origin, ok, build: null, lines };
  }
  // Run 102: 502–504 from the host's proxy means no ALKAO container is running behind it.
  if ([502, 503, 504].includes(health.status)) {
    bad(`/health répond ${health.status} : aucun conteneur ALKAO en marche (Coolify → ALKAO → Logs : la ligne « ALKAO cannot start » nomme le réglage à corriger)`);
    return { origin, ok, build: null, lines };
  }
  if (health.status !== 200 || h?.service !== "alkao") {
    bad(`/health répond ${health.status} : ce n'est pas ALKAO`);
    return { origin, ok, build: null, lines };
  }
  const build = typeof h.build === "string" ? h.build : null;
  lines.push(`✔ ALKAO répond${build ? ` (version ${build.slice(0, 12)})` : ""}`);
  if (requireBuild && expectBuild && !build) bad("le serveur ne publie pas le SHA du build (Include source commit in build)");
  if (build && expectBuild && build !== expectBuild) {
    const notice = `main est à ${expectBuild.slice(0, 12)} : le dernier déploiement n'est pas encore en ligne`;
    if (requireBuild) bad(notice);
    else lines.push(`⚠ ${notice}`);
  }

    const ready = await get("/health/ready");
  const r = ready ? await json(ready) : null;
  // Run 70: the build's migrations are applied ("unknown" when the database keeps no record).
  if (ready?.status === 200) lines.push(`✔ Base de données joignable${r?.schema === "current" ? ", schéma à jour" : ""}`);
  else if (r?.schema === "behind") bad("/health/ready : des migrations de cette version ne sont pas appliquées (ALKAO_MIGRATE_ON_START ou scripts/migrate.ts)");
  else bad(`/health/ready répond ${ready?.status ?? "rien"} : la base ne répond pas`);

  // The platform home, or a white-label install's redirect to its own HTTPS home.
  const home = await get("/");
  const location = home?.headers.get("location") ?? "";
  if (home?.status === 200 && (home.headers.get("content-type") ?? "").startsWith("text/html")) lines.push("✔ Page d'accueil");
  else if (home && [301, 302, 307, 308].includes(home.status) && location.startsWith("https://")) lines.push("✔ Page d'accueil (redirigée)");
  else bad(`la page d'accueil répond ${home?.status ?? "rien"}`);

  return { origin, ok, build, lines };
}
