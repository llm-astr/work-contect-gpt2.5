#!/usr/bin/env python3
"""Dependency-free MCP stdio bridge for an OpenAI-compatible Images API."""
import base64
import ipaddress
import json
import os
from pathlib import Path
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(os.environ.get('YOMI_WORKSPACE', str(Path.home() / 'dshwork'))).expanduser().resolve()
KEY_FILE = ROOT / '.secrets' / 'yomi-image-key'
OUT = ROOT / 'generated-images'
BASE = 'https://api.yomiapi.com/v1'
LIMIT = 40 * 1024 * 1024


def key():
    value = KEY_FILE.read_text().strip() if KEY_FILE.exists() else ''
    if not value:
        raise ValueError('未配置密钥。请在本机终端运行 setup_key.py，勿在聊天中发送密钥。')
    if KEY_FILE.stat().st_mode & 0o077:
        raise ValueError('密钥文件权限过宽；请设置 chmod 600。')
    return value


def local_image(value):
    p = (ROOT / value).resolve()
    if not p.is_relative_to(ROOT) or not p.is_file():
        raise ValueError('参考图必须是工作区内的实际文件。请先将附件保存到工作区。')
    if p.stat().st_size > LIMIT:
        raise ValueError('单张图片超过 40 MiB。')
    data = p.read_bytes()
    return p, data, image_type(data)


def image_type(data):
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    raise ValueError('仅支持实际 PNG、JPEG、WebP 图片。')


def public_https(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.port not in (None, 443):
        raise ValueError('图片下载仅允许公网 HTTPS URL。')
    addresses = socket.getaddrinfo(u.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError('拒绝从本地或私有网络下载图片。')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, public_https(newurl))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('API 意外重定向；已拒绝转发凭据。')


def limited_read(response):
    data = response.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError('响应超过 40 MiB 限制。')
    return data


def api(endpoint, body, content_type):
    secret = key()
    req = urllib.request.Request(BASE + endpoint, data=body, headers={
        'Authorization': 'Bearer ' + secret, 'Content-Type': content_type,
        'User-Agent': 'DSH-Yomi-Image-MCP/1.0',
    }, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=480) as response:
            return json.loads(limited_read(response))
    except urllib.error.HTTPError as e:
        # Do not expose upstream bodies: they may contain credentials or binary data.
        raise ValueError('图片 API 返回 HTTP %s；请检查生图分组权限、参数与中转日志。不会自动重试或重复扣费。' % e.code) from None
    except (TimeoutError, urllib.error.URLError):
        raise ValueError('图片 API 超时或网络失败。请求可能已计费，请先查看中转记录，不会自动重试。') from None


def multipart(fields, files):
    boundary = 'dsh' + uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (boundary, name, value)).encode())
    for name, value in files:
        p, data, mime = local_image(value)
        # Fixed upload name prevents multipart header injection via local filenames.
        ext = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'}[mime]
        parts.append(('--%s\r\nContent-Disposition: form-data; name="%s"; filename="image.%s"\r\nContent-Type: %s\r\n\r\n' % (boundary, name, ext, mime)).encode() + data + b'\r\n')
    parts.append(('--%s--\r\n' % boundary).encode())
    return b''.join(parts), 'multipart/form-data; boundary=' + boundary


def save_response(result):
    rows = result.get('data')
    if not isinstance(rows, list) or not rows or len(rows) > 4:
        raise ValueError('响应不含预期 data 图片数组；需要核实中转返回结构。')
    content = []
    OUT.mkdir(parents=True, exist_ok=True)
    if not OUT.resolve().is_relative_to(ROOT):
        raise ValueError('输出目录不能指向工作区外。')
    for row in rows:
        if row.get('b64_json'):
            data = base64.b64decode(row['b64_json'], validate=True)
        elif row.get('url'):
            # Never send the API key to returned image URLs.
            req = urllib.request.Request(public_https(row['url']), headers={'User-Agent': 'DSH-Yomi-Image-MCP/1.0'})
            with urllib.request.build_opener(SafeRedirect()).open(req, timeout=120) as response:
                data = limited_read(response)
        else:
            raise ValueError('图片结果中缺少 b64_json 或 url。')
        if len(data) > LIMIT:
            raise ValueError('生成图片超过大小限制。')
        mime = image_type(data)
        ext = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}[mime]
        p = OUT / (uuid.uuid4().hex + ext)
        with p.open('xb') as f:
            f.write(data)
        content.append({'type': 'text', 'text': '图片已保存：' + str(p) + '\n请在回复中展示或使用 present 提供文件。'})
        content.append({'type': 'image', 'mimeType': mime, 'data': base64.b64encode(data).decode('ascii')})
    return {'content': content}


DEFAULT_MODEL = 'gpt-image-2.5'
SUNBURST_MODEL = 'gpt-image-2.5-sunburst'
MODELS = (SUNBURST_MODEL, DEFAULT_MODEL)
QUALITY = ('auto', 'low', 'medium', 'high', 'xhigh', 'max')

COMMON = {
    'prompt': {'type': 'string', 'minLength': 1, 'description': '完整生图/编辑提示词'},
    'model': {'type': 'string', 'enum': list(MODELS), 'description': '无分辨率声明或1K使用 gpt-image-2.5；明确声明2K/4K或指定超过2048像素长边的目标尺寸时使用 gpt-image-2.5-sunburst。任何比例只影响构图，不触发模型升级或尺寸推断；显式 model 可覆盖'},
    'size': {'type': 'string', 'description': '输出像素尺寸 WIDTHxHEIGHT；宽高须为16的倍数，比例1:3至3:1，最大3840x2160'},
    'quality': {'type': 'string', 'enum': list(QUALITY), 'description': '图像质量；sunburst 支持 low、medium、high、xhigh、max、auto'},
}
TOOLS = [
    {'name': 'status', 'description': '检查生图配置，不调用外部 API、不消耗额度，不显示密钥。', 'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
    {'name': 'generate_image', 'description': '付费文生图：无分辨率声明或声明1K时调用 gpt-image-2.5；明确声明2K/4K或指定最长边超过2048像素的目标尺寸时调用 gpt-image-2.5-sunburst。任何构图比例只影响长宽比，不推断尺寸、不升级模型。支持官方 GPT Image 任意尺寸（宽高16倍数、比例1:3至3:1、最大3840x2160）及 auto/low/medium/high/xhigh/max 质量。显式 model 可覆盖自动选择。仅在用户要求时调用；每次一张，不自动重试。', 'inputSchema': {'type': 'object', 'properties': COMMON, 'required': ['prompt'], 'additionalProperties': False}},
    {'name': 'edit_image', 'description': '付费图生图/图像编辑：无分辨率声明或声明1K时调用 gpt-image-2.5；明确声明2K/4K或指定最长边超过2048像素的目标尺寸时调用 gpt-image-2.5-sunburst。任何构图比例只影响长宽比，不推断尺寸、不升级模型。支持 GPT Image 尺寸（宽高16倍数、比例1:3至3:1、最大3840x2160）及 auto/low/medium/high/xhigh/max 质量。显式 model 可覆盖自动选择。参考图必须先保存到工作区；可选 PNG 蒙版。每次一张，不自动重试。', 'inputSchema': {'type': 'object', 'properties': dict(COMMON, image_paths={'type': 'array', 'items': {'type': 'string'}, 'minItems': 1, 'maxItems': 4}, mask_path={'type': 'string', 'description': '可选 PNG 蒙版，透明区域编辑；需与原图尺寸匹配'}), 'required': ['prompt', 'image_paths'], 'additionalProperties': False}},
]


def select_model(args):
    """Route ordinary/1K requests to 2.5 and 2K/4K requests to Sunburst."""
    explicit = args.get('model')
    if explicit:
        return explicit
    prompt = args.get('prompt', '')
    import re
    high_resolution = bool(re.search(r'(?i)(?<![a-z0-9])(?:2k|4k)(?![a-z0-9])', prompt))
    size = args.get('size')
    if isinstance(size, str):
        match = re.fullmatch(r'(\d{2,5})x(\d{2,5})', size)
        if match:
            width, height = map(int, match.groups())
            # User-confirmed provider limit: ordinary 2.5 supports a longest edge <=2048.
            # Only an explicit pixel target is tested here; ratios never create a size.
            if max(width, height) > 2048:
                high_resolution = True
    return SUNBURST_MODEL if high_resolution else DEFAULT_MODEL


def call(name, args):
    if name == 'status':
        try:
            key()
            state = '已配置密钥（未验证远端）'
        except ValueError as e:
            state = str(e)
        return {'content': [{'type': 'text', 'text': json.dumps({'default_model': DEFAULT_MODEL, 'available_models': MODELS, 'base_url': BASE, 'credentials': state, 'workspace': str(ROOT), 'official_max_size': '3840x2160'}, ensure_ascii=False)}]}
    tool = next((t for t in TOOLS if t['name'] == name), None)
    if not tool:
        raise ValueError('未知工具。')
    schema = tool['inputSchema']
    if set(args) - set(schema['properties']) or any(k not in args for k in schema.get('required', [])):
        raise ValueError('工具参数缺失或包含未知字段。')
    if not isinstance(args.get('prompt'), str) or not args['prompt'].strip():
        raise ValueError('prompt 必须是非空字符串。')
    model = select_model(args)
    if model not in MODELS:
        raise ValueError('model 仅支持 gpt-image-2.5-sunburst 或 gpt-image-2.5。')
    fields = {'model': model, 'prompt': args['prompt'], 'n': 1}
    if 'size' in args:
        size = args['size']
        if not isinstance(size, str) or size != 'auto':
            import re
            match = re.fullmatch(r'(\d{2,5})x(\d{2,5})', size) if isinstance(size, str) else None
            if not match:
                raise ValueError('size 必须为 auto 或 WIDTHxHEIGHT。')
            width, height = map(int, match.groups())
            if width % 16 or height % 16:
                raise ValueError('GPT Image 尺寸的宽和高都必须是 16 的倍数。')
            if max(width, height) > 3840 or min(width, height) > 2160:
                raise ValueError('尺寸超过官方最大范围 3840x2160。')
            if max(width, height) / min(width, height) > 3:
                raise ValueError('宽高比必须在 1:3 到 3:1 之间。')
        fields['size'] = size
    if 'quality' in args:
        quality = args['quality']
        if quality not in QUALITY:
            raise ValueError('quality 必须为 auto、low、medium、high、xhigh 或 max。')
        if quality in ('xhigh', 'max') and model != 'gpt-image-2.5-sunburst':
            raise ValueError('xhigh 和 max 质量仅为 sunburst 提供；请切换模型或使用 high。')
        fields['quality'] = quality
    if model == SUNBURST_MODEL:
        from approval import require_approval
        require_approval(ROOT, name, args)
    if name == 'generate_image':
        result = api('/images/generations', json.dumps(fields).encode(), 'application/json')
    else:
        paths = args['image_paths']
        if not isinstance(paths, list) or not 1 <= len(paths) <= 4 or any(not isinstance(p, str) for p in paths):
            raise ValueError('image_paths 需要 1–4 个本地图片路径。')
        files = [('image' if len(paths) == 1 else 'image[]', p) for p in paths]
        if args.get('mask_path'):
            if local_image(args['mask_path'])[2] != 'image/png':
                raise ValueError('蒙版必须为 PNG。')
            files.append(('mask', args['mask_path']))
        body, ct = multipart(fields, files)
        result = api('/images/edits', body, ct)
    response = save_response(result)
    response['content'].insert(0, {'type': 'text', 'text': '实际请求模型：' + model + '；请求尺寸：' + fields.get('size', '未指定（上游自动）')})
    return response


def handle(req):
    method = req.get('method')
    if method == 'initialize':
        return {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'yomi-image', 'version': '1.0.0'}, 'instructions': 'Use generate_image for text-to-image, edit_image for reference images or editing. No resolution declaration or 1K uses gpt-image-2.5. Explicit 2K/4K or a requested target size with a longest edge above 2048 pixels uses gpt-image-2.5-sunburst. Any composition ratio affects aspect ratio only; it never implies a pixel size or triggers model upgrade. Explicit model overrides routing but all Sunburst calls require one-use local interactive user approval before any paid request. Never execute the approval command yourself. Never invent 2K/4K or pixel sizes from aspect ratios. Supported size follows official GPT Image rules: WIDTHxHEIGHT, dimensions divisible by 16, aspect ratio 1:3 to 3:1, maximum 3840x2160. sunburst supports auto/low/medium/high/xhigh/max quality. These calls incur API charges. Never auto-retry failed image requests. Keep a normal tool-capable chat model selected. Return saved image paths to user and display images.'}
    if method == 'ping':
        return {}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        p = req.get('params', {})
        try:
            return call(p['name'], p.get('arguments', {}))
        except ValueError as e:
            return {'isError': True, 'content': [{'type': 'text', 'text': str(e)}]}
        except Exception as e:
            return {'isError': True, 'content': [{'type': 'text', 'text': '操作失败（%s）；请检查本地文件、网络及中转日志。未自动重试。' % type(e).__name__}]}
    raise ValueError('Method not found')


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
            if 'id' not in req:
                continue
            try:
                response = {'jsonrpc': '2.0', 'id': req['id'], 'result': handle(req)}
            except ValueError:
                response = {'jsonrpc': '2.0', 'id': req['id'], 'error': {'code': -32601, 'message': 'Method not found'}}
        except (ValueError, TypeError):
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Parse error'}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
