/**
 * corpus/jcs.mjs against the examples of RFC 8785 (JSON Canonicalization Scheme): the sample of
 * section 3.2.2, the sorting example of section 3.2.3, and the number serialisation table of
 * appendix B (IEEE-754 bit patterns and their expected text).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { jcs, sha256Jcs } from '../corpus/jcs.mjs';

test('JCS: RFC 8785 section 3.2.2 sample (numbers, string escapes, literals, member order)', () => {
  // The RFC's input and output text, with every backslash of the JSON text doubled for JavaScript.
  const input = '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n'
    + '  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n  "literals": [null, true, false]\n}';
  const want = '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(jcs(JSON.parse(input)), want);
  // The RFC gives the UTF-8 bytes of that output; their start and end.
  const bytes = Buffer.from(want, 'utf8');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '7b226c6974657261');
  assert.equal(bytes.subarray(-9).toString('hex'), '5c5c5c5c5c222f227d');
  assert.ok(bytes.includes(Buffer.from('22e282ac24', 'hex')), 'the euro sign as UTF-8, unescaped');
});

test('JCS: RFC 8785 section 3.2.3 sorting (UTF-16 code units, not code points)', () => {
  const input = '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n  "1": "One",\n'
    + '  "\\ud83d\\ude00": "Emoji: Grinning Face",\n  "\\u0080": "Control",\n  "\\u00f6": "Latin Small Letter O With Diaeresis"\n}';
  const out = jcs(JSON.parse(input));
  // Read the member order from the text (a parsed object would put the integer-like key "1" first).
  const order = [...out.matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis', 'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh']);
  assert.ok(out.startsWith('{"\\r":"Carriage Return","1":"One","\u0080":"Control"'), out);
});

test('JCS: RFC 8785 appendix B number serialisation', () => {
  const ieee = (hex) => Buffer.from(hex, 'hex').readDoubleBE(0);
  const table = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  for (const [hex, want] of table) assert.equal(jcs(ieee(hex)), want, hex);
  // NaN and Infinity (7fffffffffffffff, 7ff0000000000000) have no JSON form.
  assert.throws(() => jcs(ieee('7fffffffffffffff')), /NaN and Infinity/);
  assert.throws(() => jcs(ieee('7ff0000000000000')), /NaN and Infinity/);
});

test('JCS: nesting, empty containers, undefined members, refusals; sha256Jcs hashes the UTF-8 text', () => {
  assert.equal(jcs({ b: [], a: {}, c: [{ z: 1, y: [true] }], d: undefined }), '{"a":{},"b":[],"c":[{"y":[true],"z":1}]}');
  assert.equal(jcs([undefined, 'x']), '[null,"x"]');
  assert.equal(jcs(' \u007f'), '" \u007f"', 'no escape beyond what JSON.stringify does');
  assert.throws(() => jcs('\ud800'), /lone surrogate/);
  assert.throws(() => jcs({ k: '\udc00x' }), /lone surrogate/);
  assert.throws(() => jcs(1n), /bigint/);
  assert.throws(() => jcs(() => 1), /function/);
  // Member order and whitespace do not change the hash; any value change does.
  const a = JSON.parse('{ "b" : 1, "a" : [ 1.0, "é" ] }');
  const b = { a: [1, 'é'], b: 1 };
  assert.equal(sha256Jcs(a), sha256Jcs(b));
  assert.equal(sha256Jcs(a), createHash('sha256').update('{"a":[1,"é"],"b":1}', 'utf8').digest('hex'));
  assert.notEqual(sha256Jcs(a), sha256Jcs({ a: [1, 'e'], b: 1 }));
});
