// A secret must never be committed: this repository is public. `npm run check:secrets` (part of
// `npm run qa`, so CI refuses the PR) looks through every tracked file for values shaped like real
// keys and for filled-in secrets in .env.example. It prints the file, the line and the kind of
// secret, never the value. A real leak still has to be rotated: removing it from a file leaves it
// in the git history.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export interface Finding {
  file: string;
  line: number;
  kind: string;
}

const PATTERNS: [string, RegExp][] = [
  ["Stripe secret key", /\b[rs]k_(live|test)_[A-Za-z0-9]{20,}/],
  ["Stripe or Resend webhook secret", /\bwhsec_[A-Za-z0-9+/=]{16,}/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/],
  ["Resend API key", /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{12,}/],
  ["Twilio API key", /\bSK[0-9a-f]{32}\b/],
  ["Anthropic API key", /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_-]{20,}/],
  ["Private key", /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/],
];

/** Hosts a test or example connection string may name with a password. */
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|db|db\.internal|postgres|[a-z0-9.-]*\.example(\.[a-z]+)?)$/i;
const PLACEHOLDER = /[<>…$*{}]|^(password|secret|changeme|x+)$/i;

/** A database address with a real-looking password on a remote host. */
function databasePassword(line: string): boolean {
  for (const m of line.matchAll(/postgres(?:ql)?:\/\/[^:/@\s"'`]+:([^@\s"'`]+)@([^:/?\s"'`]+)/g)) {
    if (!PLACEHOLDER.test(m[1]!) && !LOCAL_HOSTS.test(m[2]!)) return true;
  }
  return false;
}

/** .env.example documents the settings: a secret's line must stay empty. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|_KEY|_KEYS|DATABASE_URL|ACCOUNT_SID)$/;

export function scan(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  const example = /(^|\/)\.env\.example$/.test(file);
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [kind, re] of PATTERNS) if (re.test(line)) found.push({ file, line: i + 1, kind });
    if (databasePassword(line)) found.push({ file, line: i + 1, kind: "database password" });
    const m = example ? /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line) : null;
    if (m && SECRET_NAME.test(m[1]!) && m[2] !== "" && m[2] !== '""' && m[2] !== "''") {
      found.push({ file, line: i + 1, kind: `${m[1]} filled in .env.example` });
    }
  });
  return found;
}

const SKIP = /(^|\/)(package-lock\.json|bun\.lockb?|node_modules\/)|\.(png|jpe?g|gif|webp|ico|woff2?|pdf|zip|gz)$/i;

export function scanRepository(root = process.cwd()): Finding[] {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((f) => f && !SKIP.test(f));
  return files.flatMap((f) => {
    let text: string;
    try {
      text = readFileSync(`${root}/${f}`, "utf8");
    } catch {
      return [];
    }
    return scan(f, text);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const found = scanRepository();
  for (const f of found) console.error(`✘ ${f.file}:${f.line} looks like a ${f.kind}`);
  if (found.length) {
    console.error(`\n${found.length} possible secret(s). Remove them, and rotate any real one: it stays in the git history.`);
    process.exit(1);
  }
  console.log("✔ no secret in the tracked files");
}
