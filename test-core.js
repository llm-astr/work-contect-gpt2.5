import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { tools, selectModel, run } from './image-core.js';

const KEY = 'test-secret-never-send-to-upstream';
function png(width = 16, height = 16) {
  const data = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(data);
  data.write('IHDR', 12); data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}
function imageResponse(data = png()) { return Response.json({ data: [{ b64_json: data.toString('base64') }] }); }
async function fixture(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'yomi-core-'));
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => { calls.push(args); return imageResponse(); };
  t.after(async () => { globalThis.fetch = original; await rm(workspace, { recursive: true, force: true }); });
  return { workspace, apiKey: KEY, calls };
}

test('raw MCP descriptors have closed JSON schemas', () => {
  assert.deepEqual(tools.map(tool => tool.name), ['status', 'generate_image', 'edit_image']);
  for (const tool of tools) { assert.equal(tool.inputSchema.type, 'object'); assert.equal(tool.inputSchema.additionalProperties, false); }
  assert.equal(tools[2].inputSchema.properties.image_paths.maxItems, 4);
});
test('routing respects resolution tokens/size/explicit model, never infers ratio', () => {
  for (const prompt of ['picture', '1K', '16:9 cinematic', '32k', 'x2k', '2kfoo']) assert.equal(selectModel({ prompt }), 'gpt-image-2.5');
  for (const prompt of ['2K', '请生成4k图片', '(4K)']) assert.equal(selectModel({ prompt }), 'gpt-image-2.5-sunburst');
  assert.equal(selectModel({ size: '2048x2048' }), 'gpt-image-2.5');
  assert.equal(selectModel({ size: '3072x2048' }), 'gpt-image-2.5-sunburst');
  assert.equal(selectModel({ prompt: '4K', model: 'gpt-image-2.5' }), 'gpt-image-2.5');
});
test('status works without key/workspace and never exposes key or fetches', async t => {
  const options = await fixture(t);
  assert.match((await run('status', {}, { workspace: '/does/not/exist' })).content[0].text, /未配置/);
  const result = await run('status', {}, options);
  assert.match(result.content[0].text, /已配置/);
  assert.ok(!JSON.stringify(result).includes(KEY)); assert.equal(options.calls.length, 0);
});
test('JSON generation fixed endpoint, fields/no inferred size, UUID save and MCP content', async t => {
  const options = await fixture(t);
  const result = await run('generate_image', { prompt: '16:9 photograph', quality: 'high' }, options);
  assert.equal(options.calls.length, 1);
  const [url, request] = options.calls[0];
  assert.equal(url, 'https://api.yomiapi.com/v1/images/generations'); assert.equal(request.redirect, 'manual');
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`); assert.equal(request.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.body), { model: 'gpt-image-2.5', prompt: '16:9 photograph', n: 1, quality: 'high' });
  assert.ok(request.signal instanceof AbortSignal); assert.match(result.content[0].text, /gpt-image-2.5.*未指定/);
  const file = result.content[1].text.split('\n')[0].slice('图片已保存：'.length);
  assert.match(path.basename(file), /^[0-9a-f-]{36}\.png$/); assert.deepEqual(await readFile(file), png());
  assert.match(result.content[1].text, /16x16/);
  assert.deepEqual(result.content[2], { type: 'image', mimeType: 'image/png', data: png().toString('base64') });
});
test('Sunburst approval is awaited, exact true and fresh approval required', async t => {
  const options = await fixture(t);
  for (const approve of [undefined, async () => false, async () => 'true', async () => { throw new Error(KEY); }]) {
    await assert.rejects(run('generate_image', { prompt: '4K' }, { ...options, approve }), /批准/); assert.equal(options.calls.length, 0);
  }
  let release, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const pending = run('generate_image', { prompt: '2K', size: '3072x2048', quality: 'max' }, { ...options, approve: details => {
    assert.deepEqual(details, { model: 'gpt-image-2.5-sunburst', size: '3072x2048', prompt: '2K' });
    ready(); return new Promise(resolve => { release = resolve; });
  } });
  await entered; assert.equal(options.calls.length, 0); release(true); await pending; assert.equal(options.calls.length, 1);
  await assert.rejects(run('generate_image', { prompt: '4K' }, options), /批准/); assert.equal(options.calls.length, 1);
});
test('explicit default overrides resolution and does not require approval', async t => {
  const options = await fixture(t); await run('generate_image', { prompt: '4K', model: 'gpt-image-2.5' }, options);
  assert.equal(JSON.parse(options.calls[0][1].body).model, 'gpt-image-2.5');
});
test('invalid arguments/credentials rejected before API', async t => {
  const options = await fixture(t);
  for (const args of [{}, { prompt: '' }, { prompt: 'x', unknown: true }, { prompt: 'x', model: '' }, { prompt: 'x', size: '16:9' }, { prompt: 'x', size: '1025x1024' }, { prompt: 'x', size: '4096x2160' }, { prompt: 'x', size: '1024x16' }, { prompt: 'x', quality: 'max' }, { prompt: 'x', quality: 'bogus' }]) await assert.rejects(run('generate_image', args, options));
  await assert.rejects(run('generate_image', { prompt: 'x' }, { workspace: options.workspace }), /未配置/);
  await assert.rejects(run('unknown', {}, options), /未知/); await assert.rejects(run('status', { apiKey: KEY }, options), /未知字段/);
  assert.equal(options.calls.length, 0);
});
test('native multipart edit, fixed filenames, repeated image[] and mask', async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.workspace, 'weird"name.png'), png()); await writeFile(path.join(options.workspace, 'mask.png'), png());
  await run('edit_image', { prompt: 'edit', image_paths: ['weird"name.png', 'mask.png'], mask_path: 'mask.png', size: 'auto' }, options);
  const [url, request] = options.calls[0]; assert.equal(url, 'https://api.yomiapi.com/v1/images/edits'); assert.ok(request.body instanceof FormData);
  assert.equal(request.headers['Content-Type'], undefined); assert.equal(request.body.get('n'), '1'); assert.equal(request.body.get('size'), 'auto');
  assert.equal(request.body.getAll('image[]').length, 2); assert.equal(request.body.getAll('image[]')[0].name, 'image.png'); assert.equal(request.body.get('mask').type, 'image/png');
  await run('edit_image', { prompt: 'edit', image_paths: ['mask.png'] }, options); assert.ok(options.calls[1][1].body.get('image'));
});
test('local files reject traversal/symlink/magic/oversize/count/mask mismatch', async t => {
  const options = await fixture(t), outside = await mkdtemp(path.join(os.tmpdir(), 'yomi-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'outside.png'), png()); await symlink(outside, path.join(options.workspace, 'escape'));
  await writeFile(path.join(options.workspace, 'bad.png'), 'fake'); await writeFile(path.join(options.workspace, 'image.png'), png());
  await writeFile(path.join(options.workspace, 'big.png'), Buffer.alloc(40 * 1024 * 1024 + 1));
  await writeFile(path.join(options.workspace, 'different.png'), png(32, 32)); await writeFile(path.join(options.workspace, 'mask.jpg'), Buffer.from([255, 216, 255]));
  for (const image_paths of [[], Array(5).fill('image.png'), ['escape/outside.png'], [path.join(outside, 'outside.png')], ['bad.png'], ['big.png'], [42]]) await assert.rejects(run('edit_image', { prompt: 'x', image_paths }, options));
  for (const mask_path of ['mask.jpg', 'different.png']) await assert.rejects(run('edit_image', { prompt: 'x', image_paths: ['image.png'], mask_path }, options), /蒙版/);
  assert.equal(options.calls.length, 0);
});
test('API errors/redirects/network exceptions sanitized without retries', async t => {
  const options = await fixture(t); let count = 0;
  for (const reply of [() => new Response(KEY, { status: 500 }), () => new Response('', { status: 302, headers: { Location: 'https://evil.example' } }), () => { throw new Error(KEY); }]) {
    globalThis.fetch = async () => { count++; return reply(); };
    await assert.rejects(run('generate_image', { prompt: 'x' }, options), error => !error.message.includes(KEY) && /不会自动重试/.test(error.message));
  }
  assert.equal(count, 3);
});
test('abort prevents API and cancels stalled approval promptly', async t => {
  const options = await fixture(t);
  await assert.rejects(run('generate_image', { prompt: 'x' }, { ...options, signal: AbortSignal.abort() }), /取消/);
  const controller = new AbortController(); let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const waiting = run('generate_image', { prompt: '2K' }, { ...options, signal: controller.signal, approve: () => { entered(); return new Promise(() => {}); } });
  await ready; controller.abort(); await assert.rejects(waiting, /取消/); assert.equal(options.calls.length, 0);
});
test('response parsing and bounded reads, output symlink rejection', async t => {
  const options = await fixture(t);
  for (const reply of [() => new Response('not JSON'), () => Response.json({ data: [] }), () => Response.json({ data: [{ b64_json: '!!!=' }] }), () => imageResponse(Buffer.from('fake')), () => new Response('x', { headers: { 'Content-Length': String(40 * 1024 * 1024 + 1) } }), () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(40 * 1024 * 1024)); c.enqueue(new Uint8Array(1)); c.close(); } }))]) {
    globalThis.fetch = async () => reply(); await assert.rejects(run('generate_image', { prompt: 'x' }, options));
  }
  const nested = path.join(options.workspace, 'nested'); await mkdir(nested); await symlink(os.tmpdir(), path.join(nested, 'generated-images'));
  globalThis.fetch = async () => imageResponse(); await assert.rejects(run('generate_image', { prompt: 'x' }, { ...options, workspace: nested }), /输出目录/);
});
test('download URL policy rejects credentials, HTTP and private/special IPs', async t => {
  const options = await fixture(t);
  for (const url of ['http://example.com/x', 'https://u:p@example.com/x', 'https://example.com:444/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/x', 'https://[::1]/x', 'https://[::ffff:127.0.0.1]/x', 'https://[2001:db8::1]/x', 'https://192.0.2.1/x', 'https://100.64.0.1/x', 'https://198.18.0.1/x']) {
    globalThis.fetch = async () => Response.json({ data: [{ url }] });
    await assert.rejects(run('generate_image', { prompt: 'x' }, options), /公网|私有|特殊/);
  }
});
test('public downloads pin validated DNS, never forward key, revalidate redirect DNS', async t => {
  const options = await fixture(t);
  const originalLookup = dns.lookup, originalRequest = https.request;
  t.after(() => { dns.lookup = originalLookup; https.request = originalRequest; syncBuiltinESMExports(); });
  const downloads = [];
  dns.lookup = async hostname => hostname === 'private.example' ? [{ address: '10.0.0.1', family: 4 }] : [{ address: '8.8.8.8', family: 4 }];
  https.request = (url, request, callback) => {
    downloads.push([url, request]);
    assert.equal(request.headers.Authorization, undefined); assert.equal(request.agent, false);
    request.lookup(url.hostname, { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    const req = new EventEmitter();
    req.end = () => {
      const response = Readable.from([png()]);
      response.statusCode = url.pathname === '/redirect' ? 302 : 200;
      response.headers = url.pathname === '/redirect' ? { location: 'https://private.example/x' } : {};
      callback(response);
    };
    return req;
  };
  syncBuiltinESMExports();
  globalThis.fetch = async () => Response.json({ data: [{ url: 'https://public.example/image' }] });
  const result = await run('generate_image', { prompt: 'x' }, options);
  assert.equal(result.content.at(-1).type, 'image'); assert.equal(downloads.length, 1);
  globalThis.fetch = async () => Response.json({ data: [{ url: 'https://public.example/redirect' }] });
  await assert.rejects(run('generate_image', { prompt: 'x' }, options), /私有/);
  assert.equal(downloads.length, 2); // redirect rejected before private connect
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]; syncBuiltinESMExports();
  await assert.rejects(run('generate_image', { prompt: 'x' }, options), /私有/); assert.equal(downloads.length, 2);
});
