// Files copied out of a digest-pinned official image (WC13): the backend of redis-tracker is the redis-server executable of
// docker.io/library/redis, which npm does not carry and the sandbox's install network (registry.npmjs.org only) cannot
// fetch. The image is pinned by the digest of its index in loop/fixtures.json (`binary_image`); the driver pulls it like
// any other pinned image, creates a container of it WITHOUT starting it (`docker create`, no network), copies the named
// files out with `docker cp`, checks each file's sha256 against the pin, and puts them in a read-only volume of the
// fixture's sandbox container. No code of the image runs outside the sandbox, and none of it runs at all except the
// copied executable, started by the fixture's backend under the same limits as the rest of the container.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';

/** Docker's name for this machine's CPU, as the files of fixtures.json are keyed. */
export function dockerPlatform(cpu = arch()) {
  const p = { x64: 'linux/amd64', arm64: 'linux/arm64' }[cpu];
  if (!p) throw new Error(`no pinned binary image files for ${cpu}`);
  return p;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Copies `spec.files[platform]` out of `spec.ref` into `outDir`, each checked against its pin (a mismatch throws, with
 * nothing kept to run). `dock(argv)` runs one docker command and resolves { exit, stderr_tail? }. Returns
 * { ref, platform, files: { name: sha256 } }.
 */
export async function extractBinaryImage({ dock, spec, platform, outDir, containerName, labelArgs = [] }) {
  const files = spec.files?.[platform];
  if (!files) throw new Error(`the fixture pins no files for ${platform}`);
  mkdirSync(outDir, { recursive: true });
  const ok = async (argv, what) => {
    const r = await dock(argv);
    if (r.exit !== 0) throw new Error(`${what} failed (exit ${r.exit})${r.stderr_tail ? `: ${String(r.stderr_tail).slice(0, 300)}` : ''}`);
  };
  await ok(['create', '--platform', platform, '--network', 'none', '--name', containerName, ...labelArgs, spec.ref], 'docker create');
  const got = {};
  try {
    for (const [name, pin] of Object.entries(files)) {
      const dest = join(outDir, name);
      await ok(['cp', `${containerName}:${pin.path}`, dest], `docker cp ${name}`);
      if (!lstatSync(dest).isFile()) throw new Error(`${name} is not a regular file`);
      const h = sha256(readFileSync(dest));
      if (h !== pin.sha256) throw new Error(`${name} copied from ${spec.ref} has sha256 ${h}, not the pinned ${pin.sha256}`);
      chmodSync(dest, name === 'redis-server' ? 0o755 : 0o644);
      got[name] = h;
    }
  } finally {
    await dock(['rm', '-f', containerName]).catch(() => {});
  }
  return { ref: spec.ref, platform, files: got };
}
