/**
 * Secrets out of what the driver writes down: every logged command line, every line of output it
 * logs, the archived manifest and meta.json's strings. Host-side only. What runs is never changed:
 * Docker, the CLI and the containers get the real values.
 *
 * A Scrubber knows secret values (name -> values) and replaces them with <redacted:NAME>:
 *   - values under a secret-like env name (SECRET_ENV_NAME) in any `env` object of a target entry,
 *     before and after its templates are filled; the password and secret query parameters of every
 *     URL in any string of the entry; every volatile capture (and capture derived from one);
 *   - a value of 6 characters or more wherever it appears, a shorter one only as a whole token.
 * It also applies pattern rules that need no list: the password of a scheme://user:password@ URL (up
 * to the last @ before the host), password / pwd / pass / token / key query parameters,
 * NAME=VALUE with a secret-like NAME, `--requirepass x`, `--password x`, mysql's `-px`, SQL
 * `PASSWORD 'x'` / `IDENTIFIED BY 'x'`, curl's `-u user:x`, and `Authorization: Bearer|Basic x`.
 */
import { StringDecoder } from 'node:string_decoder';

/** Env names whose values are secrets. */
export const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PWD|KEY|CREDENTIAL|CREDS|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|CONNECTION_STRING|PRIVATE|SIGNING|_PASS$|_PW$|_PAT$|_URL$|_URI$)/i;
/** Secret env names whose value is usually a URL: only its secret parts are hidden when it is one. */
const URL_ENV_NAME = /(DATABASE_URL|CONNECTION_STRING|_URL$|_URI$)/i;
/** A value this long or longer is replaced wherever it appears; a shorter one only as a whole token. */
export const MIN_SUBSTRING = 6;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isUrl = (v) => /^[a-z][a-z0-9+.-]{0,31}:\/\/\S*$/i.test(v);
/** scheme://<userinfo up to the last @ in the token>@host */
// The scheme starts at a word start only (lookbehind): without it a long run of letters is tried at
// every position, which is quadratic on a flood of output.
// Spans are bounded (user info 256, host 2048 characters) so a flood like a://a://a://... stays linear.
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s'"<>]{0,256})@(?=[^\s'"<>@]{0,2048}(?:[\s'"<>]|$))/gi;
const QUERY_SECRET = /([?&;](password|passwd|pwd|pass|token|access_token|secret|api_?key|apikey|key|auth)=)([^&\s'"#;]*)/gi;
const NAME_VALUE = /(^|[\s;'"(])([A-Za-z_][A-Za-z0-9_]{0,127})=([^\s'";]+)/g;
const FLAG_VALUE = /(--?(?:requirepass|password|passwd|pass|pwd|token|secret|api-?key|auth-token)(?:=|\s+))('[^']*'|"[^"]*"|[^\s'"]+)/gi;
const SECRET_FLAG = /^--?(requirepass|password|passwd|pass|pwd|token|secret|api-?key|auth-token)$/i;
const MYSQL_P = /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]{0,1024}?\s-p)([^\s'"]+)/gi;
const SQL_PASSWORD = /\b(PASSWORD|IDENTIFIED\s+BY)(\s+)('[^']*'|"[^"]*")/gi;
const CURL_USER = /(\b(?:curl|wget)\b[^\n]{0,1024}?\s(?:-u\s*|--user[\s=]|--http-user[\s=]))([^\s:'"]+):([^\s'"]+)/g;
const AUTH_HEADER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{4,}/g;

/** The secret parts of every URL in a string: user-info passwords and secret query parameters. */
export function urlSecrets(s) {
  const out = [];
  for (const m of String(s).matchAll(URL_USERINFO)) {
    const ui = m[2];
    const c = ui.indexOf(':');
    if (c >= 0 && ui.slice(c + 1)) out.push(ui.slice(c + 1));
  }
  for (const m of String(s).matchAll(QUERY_SECRET)) if (m[3]) out.push(m[3]);
  return out.filter((x) => !x.includes('{{'));
}

export class Scrubber {
  /** `secrets`: an optional Map of name -> iterable of values. */
  constructor(secrets = null) {
    this.values = new Map(); // value -> name
    this.re = null;
    for (const [n, vs] of secrets ?? []) for (const v of vs) this.add(n, v);
  }

  /** A secret value (a template, `{{...}}`, is not a value yet: it is added once filled). */
  add(name, value) {
    if (typeof value !== 'string' || !value || value.includes('{{') || value.startsWith('<redacted:')) return;
    if (!this.values.has(value)) {
      this.values.set(value, String(name));
      this.re = null;
    }
  }

  /** The secret values of an env object: by name, or the URL parts for a URL-like name. */
  addEnv(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string' || !SECRET_ENV_NAME.test(k)) continue;
      if (URL_ENV_NAME.test(k) && isUrl(v)) for (const p of urlSecrets(v)) this.add(k, p);
      else this.add(k, v);
    }
  }

  /** A target entry of the list: every `env` object anywhere in it, and every URL in any string. */
  addList(t) {
    const walk = (x, key) => {
      if (typeof x === 'string') { for (const p of urlSecrets(x)) this.add('url', p); return; }
      if (Array.isArray(x)) { for (const y of x) walk(y, null); return; }
      if (x && typeof x === 'object') {
        if (key === 'env') this.addEnv(x);
        for (const [k, y] of Object.entries(x)) walk(y, k);
      }
    };
    walk(t, null);
  }

  #regexes() {
    if (this.re) return this.re;
    const all = [...this.values.keys()].sort((a, b) => b.length - a.length);
    const long = all.filter((v) => v.length >= MIN_SUBSTRING).map(esc);
    const short = all.filter((v) => v.length < MIN_SUBSTRING).map(esc);
    this.re = {
      long: long.length ? new RegExp(long.join('|'), 'g') : null,
      short: short.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${short.join('|')})(?![A-Za-z0-9_])`, 'g') : null,
    };
    return this.re;
  }

  /** Any text: known values first, then the pattern rules. */
  text(s) {
    let t = String(s);
    const { long, short } = this.#regexes();
    const mark = (m) => `<redacted:${this.values.get(m) ?? 'secret'}>`;
    if (long) t = t.replace(long, mark);
    if (short) t = t.replace(short, mark);
    t = t.replace(URL_USERINFO, (m, scheme, ui) => {
      const c = ui.indexOf(':');
      return c >= 0 && ui.slice(c + 1) && !ui.slice(c + 1).startsWith('<redacted:') ? `${scheme}${ui.slice(0, c)}:<redacted:password>@` : m;
    });
    t = t.replace(QUERY_SECRET, (m, k, name, v) => (v && !v.startsWith('<redacted:') ? `${k}<redacted:${name}>` : m));
    t = t.replace(NAME_VALUE, (m, pre, name, v) => {
      if (!SECRET_ENV_NAME.test(name) || v.startsWith('<redacted:')) return m;
      if (URL_ENV_NAME.test(name) && isUrl(v)) return m; // its user info and query were handled above
      return `${pre}${name}=<redacted:${name}>`;
    });
    t = t.replace(FLAG_VALUE, (m, flag, v) => (v.includes('<redacted:') ? m : `${flag}<redacted:password>`));
    t = t.replace(MYSQL_P, (m, pre, v) => (v.startsWith('<redacted:') ? m : `${pre}<redacted:password>`));
    t = t.replace(SQL_PASSWORD, (m, kw, sp, v) => (v.includes('<redacted:') ? m : `${kw}${sp}'<redacted:password>'`));
    t = t.replace(CURL_USER, (m, pre, user, v) => (v.startsWith('<redacted:') ? m : `${pre}${user}:<redacted:password>`));
    t = t.replace(AUTH_HEADER, (m, kind) => `${kind} <redacted:authorization>`);
    return t;
  }

  /** An argv as it is logged: env forms (`--env N=V`, `--env=N=V`, `-e N=V`), secret flags' values, then text(). */
  argv(argv) {
    const isMysql = argv.some((x) => /(^|\/)(mysql|mysqldump|mysqladmin|mariadb)$/.test(String(x)));
    const isCurl = argv.some((x) => /(^|\/)(curl|wget)$/.test(String(x)));
    return argv.map((x, i) => {
      let s = String(x);
      const prev = i > 0 ? String(argv[i - 1]) : '';
      let prefix = '';
      let envForm = prev === '--env' || prev === '-e';
      if (s.startsWith('--env=')) { prefix = '--env='; s = s.slice(6); envForm = true; }
      if (envForm) {
        const eq = s.indexOf('=');
        if (eq > 0) {
          const name = s.slice(0, eq);
          const v = s.slice(eq + 1);
          if (SECRET_ENV_NAME.test(name) && v && !(URL_ENV_NAME.test(name) && isUrl(v))) return `${prefix}${name}=<redacted:${name}>`;
          if (this.values.has(v)) return `${prefix}${name}=<redacted:${this.values.get(v)}>`;
        }
        return prefix + this.text(s);
      }
      if (SECRET_FLAG.test(prev) && s) return '<redacted:password>';
      if (isCurl && (prev === '-u' || prev === '--user') && s.includes(':')) return `${s.slice(0, s.indexOf(':'))}:<redacted:password>`;
      if (isMysql && /^-p.+/.test(s)) return '-p<redacted:password>';
      return this.text(s);
    });
  }
}

/** The argv of a command as it is logged (never as it runs). `secrets`: Map name -> values. */
export function redactArgv(argv, secrets = null) {
  return (secrets instanceof Scrubber ? secrets : new Scrubber(secrets)).argv(argv);
}

/**
 * Output as it is logged, line by line (a secret is never split between two writes): push() returns
 * the scrubbed complete lines so far, end() the rest. A line longer than 1 MiB is cut at its last
 * white space before the last 4 KiB, so memory stays bounded.
 */
export class LineScrubber {
  constructor(scrubber) {
    this.s = scrubber;
    this.dec = new StringDecoder('utf8');
    this.buf = '';
  }

  push(chunk) {
    this.buf += this.dec.write(chunk);
    let cut = this.buf.lastIndexOf('\n') + 1;
    if (!cut && this.buf.length > 1024 * 1024) {
      // The last white space before the last 4 KiB (a plain scan back: linear), else that point.
      let ws = this.buf.length - 4096;
      while (ws > 0 && !/\s/.test(this.buf[ws - 1])) ws--;
      cut = ws > 0 ? ws : this.buf.length - 4096;
    }
    if (!cut) return Buffer.alloc(0);
    const out = this.s.text(this.buf.slice(0, cut));
    this.buf = this.buf.slice(cut);
    return Buffer.from(out, 'utf8');
  }

  end() {
    const rest = this.buf + this.dec.end();
    this.buf = '';
    return Buffer.from(rest ? this.s.text(rest) : '', 'utf8');
  }
}

/** Every string in a JSON-like value, scrubbed (keys kept). */
export function scrubStrings(v, s) {
  if (typeof v === 'string') return s.text(v);
  if (Array.isArray(v)) return v.map((x) => scrubStrings(x, s));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubStrings(x, s)]));
  return v;
}
