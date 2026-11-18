/**
 * Secrets out of what the driver writes down: every logged command line, every line of output it
 * logs, the archived manifest and meta.json's free-text fields. Host-side only. What runs is never
 * changed: Docker, the CLI and the containers get the real values. One Scrubber per target.
 *
 * Known values (replaced with <redacted:NAME>, with their URL-encoded, JSON-escaped and base64 forms
 * when 6 characters or longer; a shorter one only as a whole token):
 *   - values under a secret-like name (isSecretName: PASSWORD, *_PASS, *_PW, *_SECRET, *_TOKEN,
 *     *_API_KEY, *_PRIVATE_KEY, *_CREDENTIALS, *_PAT, *_AUTH, ...; for *_URL, *_URI, *_DSN and
 *     CONNECTION_STRING only the password parts) in any `env` object of a target entry;
 *   - the password of every URL and the value of every secret flag (--requirepass, --*-password,
 *     --*-pass, --*-token, --*-secret, redis-cli -a, mysql -p<pw>) in any string or argv of the entry,
 *     and secret-named YAML keys (password:, token:, secret:) in its hand manifest;
 *   - every volatile capture (and capture derived from one).
 * Never a boolean, a number, a value under 3 characters, a short plain word, or a common word
 * (COMMON_WORDS): those would corrupt unrelated text.
 * Pattern rules (no list needed): -----BEGIN ... PRIVATE KEY----- blocks, scheme://user:password@ (up
 * to the last @ before the host) and token-like user info, secret query parameters, NAME=VALUE and
 * YAML `name: value` with a secret-like name, secret flags with their value, SQL PASSWORD '...',
 * curl -u user:x, and Authorization Bearer|Basic|Token headers. Every pattern is bounded, so the
 * scrubber is linear on floods of output.
 */
import { StringDecoder } from 'node:string_decoder';

/** A secret-like name, as a whole token (`AUTH_ENABLED`, `SESSION_STORE`, `monkey` are not). */
export const SECRET_ENV_NAME = /^(?!(?:OLD)?PWD$)(?:[A-Za-z0-9_]{0,128}?(?:^|_)(?:PASSWORD|PASSWD|PASS|PW|PWD|SECRET|TOKEN|PAT|CREDENTIALS?|CREDS|AUTH|DSN|URL|URI|CONNECTION_?STRING|API_?KEY|APIKEY|(?:PRIVATE|SECRET|ACCESS|SIGNING|ENCRYPTION|MASTER|AUTH)_?KEY|(?:COOKIE|SESSION)_?SECRET)|[A-Za-z0-9_]{0,128}?PASSW(?:OR)?D)$/i;
/** Names whose value is a URL or DSN: only its password parts are secret. */
const URL_NAME = /(?:^|_)(?:DSN|URL|URI|CONNECTION_?STRING)$/i;
export const isSecretName = (n) => typeof n === 'string' && n.length <= 128 && SECRET_ENV_NAME.test(n.replace(/[-.]/g, '_'));
const isUrlName = (n) => URL_NAME.test(String(n).replace(/[-.]/g, '_'));

/** Values that are never taken as known secrets (fixture defaults that are also everyday words). */
export const COMMON_WORDS = new Set(['postgres', 'postgresql', 'password', 'passwd', 'secret', 'secrets', 'admin', 'administrator', 'root', 'changeme', 'example',
  'default', 'mongodb', 'mongo', 'rabbitmq', 'guest', 'minioadmin', 'minio', 'elastic', 'testing', 'test', 'tester', 'user', 'username', 'letmein', 'qwerty',
  'mysql', 'mariadb', 'redis', 'neo4j', 'demo', 'sample', 'localhost', 'public', 'private', 'master', 'development', 'production', 'staging', 'local', 'memory',
  'github', 'gitlab', 'docker', 'server', 'client', 'database', 'enabled', 'disabled']);

/** Whether a value may be a known secret (see the header). */
export function acceptValue(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t.length < 3 || t.length > 65536 || t.includes('{{') || t.startsWith('<redacted:')) return false;
  if (/^(true|false|yes|no|on|off|null|none|nil|undefined)$/i.test(t)) return false;
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return false;
  if (COMMON_WORDS.has(t.toLowerCase())) return false;
  if (t.length < 6 && /^[A-Za-z]+$/.test(t)) return false;
  return true;
}

export const MIN_SUBSTRING = 6;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const isUrl = (v) => /^[a-z][a-z0-9+.-]{0,31}:\/\/\S*$/i.test(v);
const tokenish = (u) => /^(gh[pousr]_|github_pat_|glpat-|xox[abpr]-|sk-|npm_)/.test(u) || (u.length >= 20 && /\d/.test(u) && /[A-Za-z]/.test(u));

// Patterns. Each is bounded so a flood of output stays linear.
const PEM = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----(?:[^-]|-(?!----BEGIN)){0,65536}?-----END [A-Z0-9 ]{0,40}-----/g;
// User info never runs past the next "://", so a flood like a://u:p@a://u:p@... costs each scheme only up to the next one.
const URL_USERINFO = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)((?:[^\s'"<>:]|:(?!\/\/)){1,256})@(?=[^\s'"<>@]{0,2048}(?:[\s'"<>]|$))/gi;
const QUERY_SECRET = /([?&;](password|passwd|pwd|pass|token|access_token|secret|api_?key|apikey|key|auth)=)([^&\s'"#;]{1,1024})/gi;
const NAME_VALUE = /(^|[\s;'"(,{])([A-Za-z_][A-Za-z0-9_]{0,127})=([^\s'";&,}]{1,4096})/g;
const YAML_VALUE = /^([ \t]{0,64}-?[ \t]{0,8})([A-Za-z0-9_.-]{1,128})([ \t]{0,8}:[ \t]{1,8})(['"]?)([^\s'"#][^'"#\n]{0,1023}?)\4[ \t]*$/gm;
const SECRET_FLAG_WORD = '(?:[a-z0-9]{1,32}-){0,4}(?:requirepass|password|passwd|pass|pwd|token|secret|api-?key|auth-token)';
const SECRET_FLAG = new RegExp(`^--?${SECRET_FLAG_WORD}$`, 'i');
const FLAG_VALUE = new RegExp(`(?<![A-Za-z0-9_-])(--?${SECRET_FLAG_WORD})(=|[ \\t]{1,16})('[^'\\n]{0,1024}'|"[^"\\n]{0,1024}"|[^\\s'"]{1,1024})`, 'gi');
// redis-cli -a, mysql -p<pw> and curl -u: anchored on the flag itself (a search forward from the
// program name on every match was a backtracking scan, seconds per MiB on a flood); the program is
// then looked for in a bounded stretch before the flag, on the same line (onLineOf).
const REDIS_A = /(?<=\s)(-a[ \t]{1,16})([^\s'"]{1,1024})/g;
const MYSQL_P = /(?<=\s)(-p)([^\s'"]{1,1024})/g;
const SQL_PASSWORD = /\b(PASSWORD|IDENTIFIED[ \t]{1,16}BY)([ \t]{1,16})('[^'\n]{0,1024}'|"[^"\n]{0,1024}")/gi;
const CURL_USER = /(?<=\s)(-u[ \t]{0,16}|--user[ \t=]|--http-user[ \t=])([^\s:'"]{1,256}):([^\s'"]{1,1024})/g;
const LOOK_BACK = 512;
const REDIS_PROG = /\bredis-cli\b/;
const MYSQL_PROG = /\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/i;
const CURL_PROG = /\b(?:curl|wget)\b/;
/** Whether `prog` appears in the LOOK_BACK characters before `offset`, on the same line. */
function onLineOf(str, offset, prog) {
  const seg = str.slice(Math.max(0, offset - LOOK_BACK), offset);
  const nl = seg.lastIndexOf('\n');
  return prog.test(nl >= 0 ? seg.slice(nl + 1) : seg);
}
const AUTH_HEADER = /\b(Bearer|Basic|Token)([ \t]{1,16})([A-Za-z0-9._~+/=-]{8,4096})/gi;
const PATTERNS = [PEM, URL_USERINFO, QUERY_SECRET, NAME_VALUE, YAML_VALUE, FLAG_VALUE, REDIS_A, MYSQL_P, SQL_PASSWORD, CURL_USER, AUTH_HEADER];

const unquote = (v) => v.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1');

/** The secret parts of every URL in a string: user-info passwords (or token-like user info) and secret query values. */
export function urlSecrets(s) {
  const out = [];
  for (const m of String(s).matchAll(URL_USERINFO)) {
    const ui = m[2];
    const c = ui.indexOf(':');
    if (c >= 0 && ui.slice(c + 1)) out.push(ui.slice(c + 1));
    else if (c < 0 && tokenish(ui)) out.push(ui);
  }
  for (const m of String(s).matchAll(QUERY_SECRET)) out.push(m[3]);
  return out;
}

/** Values of secret flags in a text (`--requirepass x`, `--db-password=x`, `redis-cli -a x`, `mysql -px`). */
export function flagSecrets(s) {
  const t = String(s);
  return [...t.matchAll(FLAG_VALUE)].map((m) => unquote(m[3])).concat(
    [...t.matchAll(REDIS_A)].filter((m) => onLineOf(t, m.index, REDIS_PROG)).map((m) => m[2]),
    [...t.matchAll(MYSQL_P)].filter((m) => onLineOf(t, m.index, MYSQL_PROG)).map((m) => m[2]),
  );
}

/** Values of secret flags in an argv (split `--flag value` and joined `--flag=value` forms). */
export function argvFlagSecrets(argv) {
  const a = argv.map(String);
  const redis = a.some((x) => /(^|\/)redis-cli$/.test(x));
  const mysql = a.some((x) => /(^|\/)(mysql|mysqldump|mysqladmin|mariadb)$/.test(x));
  const out = [];
  a.forEach((x, i) => {
    const prev = a[i - 1] ?? '';
    if (SECRET_FLAG.test(prev) || (redis && prev === '-a')) out.push(x);
    const eq = /^(--?[A-Za-z0-9-]{1,64})=(.+)$/s.exec(x);
    if (eq && SECRET_FLAG.test(eq[1])) out.push(eq[2]);
    if (mysql && /^-p.+/.test(x)) out.push(x.slice(2));
  });
  return out;
}

/** Secret-named YAML keys' values in a hand manifest (`password: x`, `token: "x"`, `REDIS_PASSWORD: x`). */
export function yamlSecrets(text) {
  return [...String(text).matchAll(YAML_VALUE)].filter((m) => isSecretName(m[2]) && !isUrlName(m[2])).map((m) => m[5]);
}

/** A trie-shaped regex source for many literals (fast on hundreds of values: shared prefixes are tried once). */
function trieSource(words) {
  const root = new Map();
  for (const w of words) {
    let n = root;
    for (const ch of w) {
      if (!n.has(ch)) n.set(ch, new Map());
      n = n.get(ch);
    }
    n.set('', true);
  }
  const emit = (n) => {
    const alts = [...n.entries()].filter(([k]) => k !== '').map(([k, c]) => esc(k) + emit(c));
    if (!alts.length) return '';
    const body = alts.length === 1 ? alts[0] : `(?:${alts.join('|')})`;
    return n.has('') ? `(?:${body})?` : body;
  };
  return emit(root);
}

export class Scrubber {
  /** `secrets`: an optional Map of name -> iterable of values. */
  constructor(secrets = null) {
    this.values = new Map(); // value (or an encoded form) -> name
    this.re = null;
    this.maxLen = 0;
    for (const [n, vs] of secrets ?? []) for (const v of vs) this.add(n, v);
  }

  /** A known secret value, with its encoded forms (unless acceptValue refuses it). */
  add(name, value) {
    if (!acceptValue(value)) return;
    const v = value.trim();
    const forms = [v];
    if (v.length >= MIN_SUBSTRING) {
      const b64 = Buffer.from(v, 'utf8').toString('base64');
      // URL-encoded as encodeURIComponent does, strictly (RFC 3986: also !'()*), and with lower-case hex.
      const strict = encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      forms.push(encodeURIComponent(v), strict, strict.replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase()), JSON.stringify(v).slice(1, -1), b64, b64.replace(/=+$/, ''), Buffer.from(v, 'utf8').toString('base64url'));
    }
    for (const f of forms) {
      if (f.length < 3 || this.values.has(f)) continue;
      this.values.set(f, String(name));
      this.maxLen = Math.max(this.maxLen, f.length);
      this.re = null;
    }
  }

  /** The secret values of an env object: by name, or the password parts for a URL-like name. */
  addEnv(env) {
    if (!env || typeof env !== 'object' || Array.isArray(env)) return;
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string' || !isSecretName(k)) continue;
      if (isUrlName(k)) {
        for (const p of urlSecrets(v)) this.add(k, p);
        for (const m of v.matchAll(NAME_VALUE)) if (isSecretName(m[2]) && !isUrlName(m[2])) this.add(k, m[3]);
      } else this.add(k, v);
    }
  }

  /** A target entry of the list: env objects, URL passwords, secret flags (strings and argv), the manifest's YAML keys. */
  addList(t) {
    const walk = (x, key) => {
      if (typeof x === 'string') {
        for (const p of urlSecrets(x)) this.add('url', p);
        for (const p of flagSecrets(x)) this.add('flag', p);
        if (key === 'manifest') for (const p of yamlSecrets(x)) this.add('manifest', p);
        return;
      }
      if (Array.isArray(x)) {
        if (x.every((y) => typeof y === 'string')) for (const p of argvFlagSecrets(x)) this.add('flag', p);
        for (const y of x) walk(y, null);
        return;
      }
      if (x && typeof x === 'object') {
        if (key === 'env') this.addEnv(x);
        for (const [k, y] of Object.entries(x)) walk(y, k);
      }
    };
    walk(t, null);
  }

  #regexes() {
    if (this.re) return this.re;
    const all = [...this.values.keys()];
    const long = all.filter((v) => v.length >= MIN_SUBSTRING);
    const short = all.filter((v) => v.length < MIN_SUBSTRING);
    this.re = {
      long: long.length ? new RegExp(trieSource(long), 'g') : null,
      short: short.length ? new RegExp(`(?<![A-Za-z0-9_])(?:${trieSource(short)})(?![A-Za-z0-9_])`, 'g') : null,
    };
    return this.re;
  }

  /** Any text: private keys, known values, then the pattern rules. */
  text(s) {
    let t = String(s);
    const { long, short } = this.#regexes();
    const mark = (m) => `<redacted:${this.values.get(m) ?? 'secret'}>`;
    t = t.replace(PEM, '<redacted:private-key>');
    if (long) t = t.replace(long, mark);
    if (short) t = t.replace(short, mark);
    t = t.replace(URL_USERINFO, (m, scheme, ui) => {
      if (ui.includes('<redacted:')) return m;
      const c = ui.indexOf(':');
      if (c >= 0) return ui.slice(c + 1) ? `${scheme}${ui.slice(0, c)}:<redacted:password>@` : m;
      return tokenish(ui) ? `${scheme}<redacted:token>@` : m;
    });
    t = t.replace(QUERY_SECRET, (m, k, name, v) => (v.startsWith('<redacted:') ? m : `${k}<redacted:${name}>`));
    t = t.replace(NAME_VALUE, (m, pre, name, v) => (!isSecretName(name) || isUrlName(name) || v.startsWith('<redacted:') ? m : `${pre}${name}=<redacted:${name}>`));
    t = t.replace(YAML_VALUE, (m, ind, key, sep, q, v) => (!isSecretName(key) || isUrlName(key) || v.startsWith('<redacted:') ? m : `${ind}${key}${sep}${q}<redacted:${key}>${q}`));
    t = t.replace(FLAG_VALUE, (m, flag, sep, v) => (v.includes('<redacted:') ? m : `${flag}${sep}<redacted:password>`));
    t = t.replace(REDIS_A, (m, pre, v, off, str) => (v.startsWith('<redacted:') || !onLineOf(str, off, REDIS_PROG) ? m : `${pre}<redacted:password>`));
    t = t.replace(MYSQL_P, (m, pre, v, off, str) => (v.startsWith('<redacted:') || !onLineOf(str, off, MYSQL_PROG) ? m : `${pre}<redacted:password>`));
    t = t.replace(SQL_PASSWORD, (m, kw, sp, v) => (v.includes('<redacted:') ? m : `${kw}${sp}'<redacted:password>'`));
    t = t.replace(CURL_USER, (m, flag, user, v, off, str) => (v.startsWith('<redacted:') || !onLineOf(str, off, CURL_PROG) ? m : `${flag}${user}:<redacted:password>`));
    t = t.replace(AUTH_HEADER, (m, kind, sp, v) => (v.startsWith('<redacted:') || !(/\d/.test(v) || v.length >= 20) ? m : `${kind}${sp}<redacted:authorization>`));
    return t;
  }

  /** An argv as it is logged: env forms (`--env N=V`, `--env=N=V`, `-e N=V`), secret flags' values (split or joined), then text(). */
  argv(argv) {
    const a = argv.map(String);
    const mysql = a.some((x) => /(^|\/)(mysql|mysqldump|mysqladmin|mariadb)$/.test(x));
    const curl = a.some((x) => /(^|\/)(curl|wget)$/.test(x));
    const redis = a.some((x) => /(^|\/)redis-cli$/.test(x));
    return a.map((x, i) => {
      let s = x;
      const prev = a[i - 1] ?? '';
      let prefix = '';
      let envForm = prev === '--env' || prev === '-e';
      if (s.startsWith('--env=')) { prefix = '--env='; s = s.slice(6); envForm = true; }
      if (envForm) {
        const eq = s.indexOf('=');
        if (eq > 0) {
          const name = s.slice(0, eq);
          const v = s.slice(eq + 1);
          if (this.values.has(v)) return `${prefix}${name}=<redacted:${this.values.get(v)}>`;
          if (isSecretName(name) && !isUrlName(name) && v) return `${prefix}${name}=<redacted:${name}>`;
          return `${prefix}${name}=${this.text(v)}`;
        }
        return prefix + this.text(s);
      }
      if (s && (SECRET_FLAG.test(prev) || (redis && prev === '-a'))) return '<redacted:password>';
      if (curl && (prev === '-u' || prev === '--user') && s.includes(':')) return `${s.slice(0, s.indexOf(':'))}:<redacted:password>`;
      if (mysql && /^-p.+/.test(s)) return '-p<redacted:password>';
      const eq = /^(--?[A-Za-z0-9-]{1,64})=(.+)$/s.exec(s);
      if (eq && SECRET_FLAG.test(eq[1])) return `${eq[1]}=<redacted:password>`;
      return this.text(s);
    });
  }

  /** How much of a stream's tail to hold back so no known value or flag+value pair is split. */
  holdLength() {
    return this.maxLen ? this.maxLen + 256 : 0;
  }

  /**
   * The largest cut <= `want` in `t` that splits no match (known value, private key, flag with its
   * value, ...), holds back holdLength() characters (or 256 when the cut is not at a newline), and
   * never passes an unterminated -----BEGIN.
   */
  safeCut(t, want, atNewline) {
    const hold = Math.max(this.holdLength(), atNewline ? 0 : 256);
    let c = Math.min(want, t.length - hold);
    if (c <= 0) return 0;
    const begin = t.lastIndexOf('-----BEGIN', c);
    if (begin >= 0 && t.indexOf('-----END', begin) < 0) c = begin;
    const spans = [];
    const { long, short } = this.#regexes();
    for (const re of [long, short, ...PATTERNS]) {
      if (!re) continue;
      for (const m of t.matchAll(re)) {
        if (m.index < c && m.index + m[0].length > c) spans.push([m.index, m.index + m[0].length]);
      }
    }
    for (let moved = true; moved;) {
      moved = false;
      for (const [s, e] of spans) if (s < c && e > c) { c = s; moved = true; }
    }
    return c;
  }
}

/** The argv of a command as it is logged (never as it runs). `secrets`: a Scrubber, or a Map name -> values. */
export function redactArgv(argv, secrets = null) {
  return (secrets instanceof Scrubber ? secrets : new Scrubber(secrets)).argv(argv);
}

const EMPTY = Buffer.alloc(0);

/**
 * Output as it is logged, scrubbed as it streams: complete lines are written as they come, except that
 * the tail that could still be part of a known value, a flag's value or a private key is held back
 * (Scrubber.safeCut). A line with no newline is cut at `limit` characters (1 MiB), at a safe point.
 * Each push only looks at its own chunk for a newline and joins the buffer only when it writes, so it
 * is linear whatever the chunk size.
 */
export class LineScrubber {
  constructor(scrubber, { limit = 1024 * 1024 } = {}) {
    this.s = scrubber;
    this.dec = new StringDecoder('utf8');
    this.parts = [];
    this.len = 0;
    this.nl = -1; // the position just after the last newline in the buffer, or -1
    this.limit = limit;
  }

  push(chunk) {
    const d = this.dec.write(chunk);
    if (!d) return EMPTY;
    const i = d.lastIndexOf('\n');
    if (i >= 0) this.nl = this.len + i + 1;
    this.parts.push(d);
    this.len += d.length;
    const over = this.len > this.limit;
    if (this.nl < 0 && !over) return EMPTY;
    // Held back: write only when twice the hold has gathered, so each write moves the stream on by at least the hold.
    const hold = this.s.holdLength();
    if (hold && !over && this.len < 2 * hold) return EMPTY;
    return this.#flush(false, over);
  }

  #flush(final, over = false) {
    const t = this.parts.length === 1 ? this.parts[0] : this.parts.join('');
    let cut = final ? t.length : this.nl >= 0 && !over ? this.nl : t.length;
    if (!final) {
      cut = this.s.safeCut(t, cut, this.nl >= 0 && cut === this.nl);
      if (cut === 0 && over) cut = Math.max(0, t.length - 256); // bounded memory: a match longer than the limit is cut
    }
    const head = t.slice(0, cut);
    const rest = t.slice(cut);
    this.parts = rest ? [rest] : [];
    this.len = rest.length;
    this.nl = rest.lastIndexOf('\n');
    if (this.nl >= 0) this.nl += 1;
    return head ? Buffer.from(this.s.text(head), 'utf8') : EMPTY;
  }

  end() {
    const tail = this.dec.end();
    if (tail) { this.parts.push(tail); this.len += tail.length; }
    return this.#flush(true);
  }
}

/** Keys of meta.json whose string values are free text (messages), the only ones that are scrubbed. */
export const FREE_TEXT_KEY = /^(harness_error|why|spawn_error|error|message|note|log|excerpt)$|_why$|_error$/;

/**
 * Free-text fields of a JSON-like value scrubbed (see FREE_TEXT_KEY); structured data (names, versions,
 * hashes, URLs of the source, tool names, the surface) is never touched. Returns { value, paths }:
 * the dotted paths of the fields that changed.
 */
export function scrubFreeText(v, s) {
  const paths = [];
  const walk = (x, path, key) => {
    if (typeof x === 'string') {
      if (key === null || !FREE_TEXT_KEY.test(key)) return x;
      const y = s.text(x);
      if (y !== x) paths.push(path);
      return y;
    }
    if (Array.isArray(x)) return x.map((y, i) => walk(y, `${path}[${i}]`, key));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, path ? `${path}.${k}` : k, k)]));
    return x;
  };
  return { value: walk(v, '', null), paths };
}

/** Back-compatible name: free-text fields only (see scrubFreeText). */
export function scrubStrings(v, s) {
  return scrubFreeText(v, s).value;
}

/** An error as text for a log or file, scrubbed. */
export function errorText(e, s) {
  return s.text(String(e?.stack ?? e?.message ?? e));
}
