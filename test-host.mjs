// Run with DSH's bundled Node; fixture mocks only the DSH service boundaries.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if (!process.env.DSH_TEST_REQUIRE_BASE) throw new Error('Set DSH_TEST_REQUIRE_BASE to a file path inside your DSH installation.');
const req = createRequire(process.env.DSH_TEST_REQUIRE_BASE);
let resolving = false;
registerHooks({ resolve(spec, context, next) {
  if (!resolving && (spec.startsWith('@deepseek-ai/') || spec.startsWith('@modelcontextprotocol/'))) {
    resolving = true;
    let resolved;
    try { resolved = req.resolve(spec); } finally { resolving = false; }
    return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }
  return next(spec, context);
} });
const { Config, apply } = await import('./index.js');
const z = (await import('@deepseek-ai/schemastery')).default;
const [config] = z.resolve({}, Config);
assert.equal(config.apiKey.get(), '');
assert.ok(config.workspace.get().endsWith('dshwork'));
const registered = [];
const ctx = {
  effect(callback) { callback(); },
  tools: { register(def) { registered.push(def); return () => {}; } },
  get() { return undefined; },
};
apply(ctx, config);
assert.equal(registered.length, 3);
const status = registered.find(t => t.name.endsWith('__status'));
const result = await status.execute({}, { signal: new AbortController().signal });
assert.ok(JSON.stringify(result).includes('gpt-image-2.5'));
assert.ok(!JSON.stringify(result).includes('Bearer'));
let key = 'first-test-key';
let workspace = config.workspace.get();
const live = { apiKey: { get: () => key }, workspace: { get: () => workspace } };
registered.length = 0;
apply(ctx, live);
const generate = registered.find(t => t.name.endsWith('__generate_image'));
const { mkdtemp, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
workspace = await mkdtemp(join(tmpdir(), 'dsh-image-live-'));
const originalFetch = globalThis.fetch;
const keys = [];
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
globalThis.fetch = async (_url, options) => {
  keys.push(options.headers.Authorization ?? options.headers.authorization);
  return new Response(JSON.stringify({ data: [{ b64_json: png }] }), { status: 200 });
};
try {
  for (const nextKey of ['first-test-key', 'updated-test-key']) {
    key = nextKey;
    await generate.execute({ prompt: 'product 3:4' }, { signal: new AbortController().signal });
  }
  assert.deepEqual(keys, ['Bearer first-test-key', 'Bearer updated-test-key']);
} finally {
  globalThis.fetch = originalFetch;
  // This exact directory was created above by mkdtemp, not a user data path.
  assert.ok(workspace.startsWith(join(tmpdir(), 'dsh-image-live-')));
  await rm(workspace, { recursive: true });
}
console.log('PASS: actual DSH schema, 3 registrations, MCP adapter, and changed Key read on next call without re-registering.');
