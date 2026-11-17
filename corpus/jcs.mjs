/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), for hashing JSON the driver records (the server
 * surface: initialize and tools/list). Host-side only; it never runs target code.
 *
 *   - object members sorted by their names' UTF-16 code units (JavaScript's default string sort);
 *   - numbers as ECMAScript's Number.prototype.toString (JSON.stringify of a finite number), which
 *     is what RFC 8785 section 3.2.2.3 prescribes; NaN and Infinity are refused;
 *   - strings as ECMAScript's JSON.stringify (section 3.2.2.2); a lone surrogate is refused, since
 *     it has no UTF-8 form to hash;
 *   - no whitespace; literals null, true, false.
 *
 * A member whose value is undefined is left out, as JSON.stringify does (values parsed from JSON
 * never are). Anything that JSON cannot carry (a function, a symbol, a bigint) is refused.
 */
import { createHash } from 'node:crypto';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The canonical JSON text of `v` (RFC 8785). Throws a TypeError on input JSON cannot carry. */
export function jcs(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('JCS: NaN and Infinity have no JSON form');
      return JSON.stringify(v); // -0 gives "0", as RFC 8785 requires
    case 'string':
      if (LONE_SURROGATE.test(v)) throw new TypeError('JCS: a string has a lone surrogate');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => jcs(x === undefined ? null : x)).join(',')}]`;
      const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
      return `{${keys.map((k) => `${jcs(k)}:${jcs(v[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`JCS: a ${typeof v} has no JSON form`);
  }
}

/** sha256 hex of the UTF-8 bytes of jcs(v). */
export function sha256Jcs(v) {
  return createHash('sha256').update(jcs(v), 'utf8').digest('hex');
}
