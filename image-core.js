// Dependency-free Node ESM core. Credentials are supplied by the host, never read here.
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

const DEFAULT_MODEL = 'gpt-image-2.5';
const SUNBURST_MODEL = 'gpt-image-2.5-sunburst';
const MODELS = [SUNBURST_MODEL, DEFAULT_MODEL];
const QUALITY = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const BASE = 'https://api.yomiapi.com/v1';
const LIMIT = 40 * 1024 * 1024;
const TIMEOUT = 480_000;
const COMMON = {
  prompt: { type: 'string', minLength: 1, description: '完整生图/编辑提示词' },
  model: { type: 'string', enum: MODELS, description: '默认 gpt-image-2.5；明确2K/4K或size长边超过2048使用sunburst。显式model覆盖；比例不推断size。' },
  size: { type: 'string', description: 'auto或WIDTHxHEIGHT；宽高为16倍数，比例1:3至3:1，最大3840x2160（也支持竖图）' },
  quality: { type: 'string', enum: QUALITY, description: 'xhigh和max仅支持sunburst' },
};

export const tools = [
  { name: 'status', description: '检查生图配置，不调用外部API、不消耗额度、不显示密钥。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'generate_image', description: '付费文生图，每次一张、不自动重试。默认gpt-image-2.5；2K/4K或size长边>2048路由sunburst；显式model覆盖，比例不推断size。任何sunburst调用必须获得本次交互批准。', inputSchema: { type: 'object', properties: { ...COMMON }, required: ['prompt'], additionalProperties: false } },
  { name: 'edit_image', description: '付费图像编辑，每次一张、不自动重试。1–4张工作区本地PNG/JPEG/WebP，可选同尺寸PNG蒙版。模型路由与文生图相同；sunburst需本次交互批准。', inputSchema: { type: 'object', properties: { ...COMMON, image_paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 4 }, mask_path: { type: 'string', minLength: 1, description: '可选PNG蒙版；需与第一张原图尺寸匹配' } }, required: ['prompt', 'image_paths'], additionalProperties: false } },
];

export function selectModel(args = {}) {
  if (args.model) return args.model;
  let high = /(?<![a-z0-9])(?:2k|4k)(?![a-z0-9])/i.test(args.prompt ?? '');
  const match = typeof args.size === 'string' && /^(\d{2,5})x(\d{2,5})$/.exec(args.size);
  if (match && Math.max(Number(match[1]), Number(match[2])) > 2048) high = true;
  return high ? SUNBURST_MODEL : DEFAULT_MODEL;
}

class CoreError extends Error {}
function fail(message) { throw new CoreError(message); }
function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function validate(name, args) {
  const tool = tools.find(item => item.name === name);
  if (!tool) fail('未知工具。');
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('工具参数必须为对象。');
  const schema = tool.inputSchema;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) || (schema.required ?? []).some(key => !Object.hasOwn(args, key))) fail('工具参数缺失或包含未知字段。');
  if (name === 'status') return null;
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) fail('prompt必须是非空字符串。');
  if (Object.hasOwn(args, 'model') && !MODELS.includes(args.model)) fail('model仅支持gpt-image-2.5或gpt-image-2.5-sunburst。');
  const model = selectModel(args);
  const fields = { model, prompt: args.prompt, n: 1 };
  if (Object.hasOwn(args, 'size')) {
    if (args.size !== 'auto') {
      const match = typeof args.size === 'string' && /^(\d{2,5})x(\d{2,5})$/.exec(args.size);
      if (!match) fail('size必须为auto或WIDTHxHEIGHT。');
      const [width, height] = match.slice(1).map(Number);
      if (!width || !height || width % 16 || height % 16) fail('宽高必须是正数且为16的倍数。');
      if (Math.max(width, height) > 3840 || Math.min(width, height) > 2160) fail('尺寸超过官方最大范围3840x2160。');
      if (Math.max(width, height) / Math.min(width, height) > 3) fail('宽高比必须在1:3到3:1之间。');
    }
    fields.size = args.size;
  }
  if (Object.hasOwn(args, 'quality')) {
    if (!QUALITY.includes(args.quality)) fail('quality必须为auto、low、medium、high、xhigh或max。');
    if (['xhigh', 'max'].includes(args.quality) && model !== SUNBURST_MODEL) fail('xhigh和max质量仅支持sunburst。');
    fields.quality = args.quality;
  }
  if (name === 'edit_image') {
    if (!Array.isArray(args.image_paths) || args.image_paths.length < 1 || args.image_paths.length > 4 || args.image_paths.some(value => typeof value !== 'string' || !value)) fail('image_paths需要1–4个本地图片路径。');
    if (Object.hasOwn(args, 'mask_path') && (typeof args.mask_path !== 'string' || !args.mask_path)) fail('mask_path必须是非空本地路径。');
  }
  return fields;
}

function imageInfo(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const dimensions = data.length >= 24 && data.toString('ascii', 12, 16) === 'IHDR' ? [data.readUInt32BE(16), data.readUInt32BE(20)] : null;
    return { mime: 'image/png', ext: 'png', dimensions };
  }
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) return { mime: 'image/jpeg', ext: 'jpg', dimensions: [data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3)] };
      offset += length;
    }
    return { mime: 'image/jpeg', ext: 'jpg', dimensions: null };
  }
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') {
    const kind = data.toString('ascii', 12, 16);
    let dimensions = null;
    if (kind === 'VP8X' && data.length >= 30) dimensions = [data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1];
    if (kind === 'VP8 ' && data.length >= 30 && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) dimensions = [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L' && data.length >= 25 && data[20] === 0x2f) dimensions = [1 + (data[21] | ((data[22] & 0x3f) << 8)), 1 + ((data[22] >> 6) | (data[23] << 2) | ((data[24] & 15) << 10))];
    return { mime: 'image/webp', ext: 'webp', dimensions };
  }
  fail('仅支持实际PNG、JPEG、WebP图片（按magic校验）。');
}

async function readLimited(stream, signal, contentLength) {
  if (contentLength != null && /^\d+$/.test(String(contentLength)) && Number(contentLength) > LIMIT) {
    if (typeof stream?.cancel === 'function') await stream.cancel().catch(() => {});
    else stream?.destroy?.();
    fail('响应超过40 MiB限制。');
  }
  if (!stream || !stream[Symbol.asyncIterator]) fail('响应缺少可读取的数据。');
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > LIMIT) fail('响应超过40 MiB限制。');
    chunks.push(buffer);
  }
  signal?.throwIfAborted();
  return Buffer.concat(chunks, total);
}

async function localImage(root, value, signal) {
  const target = await realpath(path.resolve(root, value));
  if (!contained(root, target)) fail('参考图必须是工作区内的实际文件；拒绝越界或symlink。');
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('参考图必须是工作区内的实际文件。');
    if (stat.size > LIMIT) fail('单张图片超过40 MiB。');
    const data = await readLimited(file.createReadStream({ autoClose: false }), signal, stat.size);
    return { data, ...imageInfo(data) };
  } finally {
    await file.close();
  }
}

// Positive global-unicast allowlist, plus special-purpose exclusions. Reject all
// IPv4-mapped IPv6, NAT64, 6to4, local, multicast, documentation and reserved nets.
function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('%') || address.includes('.')) return false;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const values = words.map(word => parseInt(word, 16));
  const [first, second] = values;
  return (first & 0xe000) === 0x2000 && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8)) && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function download(url, signal, redirects = 0) {
  let parsed;
  try { parsed = new URL(url); } catch { fail('图片下载仅允许公网HTTPS URL。'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) fail('图片下载仅允许公网HTTPS URL。');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await abortable(lookup(host, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) fail('拒绝从本地、私有或特殊网络下载图片。');
  // Pin the exact validated DNS records in the connection lookup; no rebinding
  // gap between validation and connect. TLS still validates the original host.
  const response = await new Promise((resolve, reject) => {
    const req = httpsRequest(parsed, {
      method: 'GET', signal, agent: false,
      headers: { 'User-Agent': 'DSH-Yomi-Image-MCP/2.0' },
      lookup: (_hostname, options, callback) => {
        const candidates = options.family ? addresses.filter(item => item.family === options.family) : addresses;
        if (!candidates.length) return callback(new Error('No public address'));
        if (options.all) callback(null, candidates);
        else callback(null, candidates[0].address, candidates[0].family);
      },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    const location = response.headers.location;
    response.destroy();
    if (!location || redirects >= 3) fail('图片下载重定向无效或超过限制。');
    return download(new URL(location, parsed).href, signal, redirects + 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.destroy();
    fail(`图片下载返回HTTP ${response.statusCode}；不会自动重试。`);
  }
  return readLimited(response, signal, response.headers['content-length']);
}

async function api(endpoint, body, apiKey, signal, json) {
  const response = await fetch(BASE + endpoint, {
    method: 'POST', redirect: 'manual', signal,
    headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': 'DSH-Yomi-Image-MCP/2.0', ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body: json ? JSON.stringify(body) : body,
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    fail('API意外重定向；已拒绝转发凭据，不会自动重试。');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(`图片API返回HTTP ${response.status}；请检查权限、参数与中转日志。不会自动重试或重复扣费。`);
  }
  const bytes = await readLimited(response.body, signal, response.headers.get('content-length'));
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('图片API返回无效JSON；不会自动重试。'); }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(LIMIT / 3)) fail('生成图片超过40 MiB或base64无效。');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const payload = padding ? value.slice(0, -padding) : value;
  if (!value.length || value.length % 4 || /[^A-Za-z0-9+/]/.test(payload)) fail('图片base64无效。');
  const data = Buffer.from(value, 'base64');
  if (data.length > LIMIT) fail('生成图片超过40 MiB。');
  return data;
}

async function saveResponse(result, root, fields, signal) {
  if (!result || !Array.isArray(result.data) || !result.data.length || result.data.length > 4) fail('响应不含预期data图片数组。');
  const output = path.join(root, 'generated-images');
  await mkdir(output, { recursive: true });
  const canonical = await realpath(output);
  if (!contained(root, canonical)) fail('输出目录不能通过symlink指向工作区外。');
  const content = [{ type: 'text', text: `实际请求模型：${fields.model}；请求尺寸：${fields.size ?? '未指定（上游自动）'}` }];
  for (const row of result.data) {
    signal.throwIfAborted();
    if (!row || typeof row !== 'object') fail('图片结果格式无效。');
    const data = row.b64_json ? decodeBase64(row.b64_json) : typeof row.url === 'string' ? await download(row.url, signal) : fail('图片结果中缺少b64_json或url。');
    const info = imageInfo(data);
    // Re-check before every save; exclusive creation never follows a file link.
    if (await realpath(output) !== canonical || !contained(root, await realpath(canonical))) fail('输出目录已改变，已停止保存。');
    const target = path.join(canonical, `${randomUUID()}.${info.ext}`);
    const file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(data, { signal }); } finally { await file.close(); }
    content.push({ type: 'text', text: `图片已保存：${target}\n实际图片尺寸：${info.dimensions ? info.dimensions.join('x') : '未知（上游图片未含可识别尺寸）'}\n请在回复中展示或使用present提供文件。` });
    content.push({ type: 'image', mimeType: info.mime, data: data.toString('base64') });
  }
  return { content };
}

/**
 * Run an MCP tool. Returns {content:[text,image,...]}, throws sanitized Error.
 * approve({model,size,prompt}) must resolve strictly true for EVERY Sunburst
 * invocation; the caller owns interactive/one-use authorization, not this core.
 * apiKey is optional for status. No disk credential lookup, caching, or retries.
 */
export async function run(name, args = {}, { workspace = process.cwd(), apiKey, signal: externalSignal, approve } = {}) {
  let signal;
  try {
    const fields = validate(name, args);
    if (name === 'status') {
      return { content: [{ type: 'text', text: JSON.stringify({ default_model: DEFAULT_MODEL, available_models: MODELS, base_url: BASE, credentials: typeof apiKey === 'string' && apiKey.trim() ? '已配置密钥（未验证远端）' : '未配置密钥，请在本机配置，勿在聊天中发送密钥。', workspace: path.resolve(workspace), official_max_size: '3840x2160' }) }] };
    }
    signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    signal.throwIfAborted();
    if (typeof apiKey !== 'string' || !apiKey.trim()) fail('未配置密钥。请在本机配置，勿在聊天中发送密钥。');
    if (/[\r\n]/.test(apiKey)) fail('密钥格式无效。');
    const root = await realpath(path.resolve(workspace));
    let body = fields;
    if (name === 'edit_image') {
      const images = [];
      for (const value of args.image_paths) images.push(await localImage(root, value, signal));
      const mask = args.mask_path ? await localImage(root, args.mask_path, signal) : null;
      if (mask && mask.mime !== 'image/png') fail('蒙版必须为PNG。');
      if (mask?.dimensions && images[0].dimensions && mask.dimensions.join('x') !== images[0].dimensions.join('x')) fail('蒙版必须与第一张参考图尺寸匹配。');
      body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.append(key, String(value));
      for (const image of images) body.append(images.length === 1 ? 'image' : 'image[]', new Blob([image.data], { type: image.mime }), `image.${image.ext}`);
      if (mask) body.append('mask', new Blob([mask.data], { type: mask.mime }), 'mask.png');
    }
    signal.throwIfAborted();
    if (fields.model === SUNBURST_MODEL) {
      if (typeof approve !== 'function') fail('Sunburst需要本次交互批准；未发起API请求。');
      // Do not leak the host callback's exception (it may contain credentials).
      let approved;
      try { approved = await abortable(approve({ model: fields.model, size: fields.size, prompt: fields.prompt }), signal); }
      catch { if (signal.aborted) signal.throwIfAborted(); fail('Sunburst批准失败；未发起API请求。'); }
      if (approved !== true) fail('Sunburst未获明确批准；未发起API请求。');
    }
    signal.throwIfAborted();
    const result = await api(name === 'generate_image' ? '/images/generations' : '/images/edits', body, apiKey.trim(), signal, name === 'generate_image');
    return await saveResponse(result, root, fields, signal);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    if (signal?.aborted || externalSignal?.aborted) throw new Error('图片操作已取消或超过480秒。请求可能已计费，请检查中转记录；不会自动重试。');
    // Never interpolate upstream error messages, response bodies, URLs or causes.
    throw new Error('图片操作失败；请检查工作区文件、网络及中转日志。请求可能已计费，不会自动重试。');
  }
}
