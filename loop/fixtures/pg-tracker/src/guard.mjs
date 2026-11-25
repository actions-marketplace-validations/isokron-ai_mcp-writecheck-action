// Makes "the JavaScript of embedded-postgres is never loaded" a runtime fact where Node can enforce it: only its
// platform package's binaries are used (backend.mjs checks their sha256). Any later import or require of
// `embedded-postgres` itself, static or dynamic, from this process fails. (module.registerHooks is Node 22.15+;
// older Node skips the hook, and test/pg-fixture.test.mjs scans the source for every import form as well.)
import { registerHooks } from 'node:module';

export const BLOCKED = /^embedded-postgres$|\/node_modules\/embedded-postgres\//;
export const hooked = typeof registerHooks === 'function';
if (hooked) {
  registerHooks({
    resolve(specifier, context, next) {
      if (BLOCKED.test(specifier)) throw new Error('embedded-postgres must not be loaded: only its binaries are used');
      const r = next(specifier, context);
      if (BLOCKED.test(r.url)) throw new Error('embedded-postgres must not be loaded: only its binaries are used');
      return r;
    },
  });
}
