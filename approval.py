"""Local interactive, one-use confirmation before paid Sunburst requests.

Not an OS security boundary against an agent with unrestricted filesystem/shell access.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import sys
import time


def digest(name, args):
    return hashlib.sha256(json.dumps([name, args], sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def directory(root):
    folder = root / '.secrets' / 'image-approvals'
    if (root / '.secrets').is_symlink() or folder.is_symlink():
        raise ValueError('拒绝符号链接确认目录。')
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return folder


def require_approval(root, name, args):
    folder = directory(root)
    fingerprint = digest(name, args)
    approved = folder / (fingerprint + '.approved.json')
    if approved.is_file() and not approved.is_symlink():
        record = json.loads(approved.read_text())
        if record.get('digest') == fingerprint and time.time() < record.get('expires', 0):
            approved.unlink()  # Verified fixed-format digest path in approval directory.
            return
    request_id = secrets.token_hex(16)
    pending = folder / (request_id + '.pending.json')
    with pending.open('x') as f:
        os.chmod(pending, 0o600)
        json.dump({'digest': fingerprint, 'tool': name, 'arguments': args, 'expires': time.time() + 600}, f, ensure_ascii=False)
    command = shlex.join([sys.executable, str(Path(__file__).resolve()), request_id, str(root)])
    raise ValueError('尚未发送：Sunburst 请求需要用户本机确认。请用户在终端运行（10分钟有效）：\n' + command
                     + '\n批准后仅可原样重发一次。模型不得自行运行确认命令，也不得自行添加2K/4K、尺寸或Sunburst。')


def approve(request_id, root):
    if not re.fullmatch(r'[0-9a-f]{32}', request_id):
        raise ValueError('无效确认编号。')
    folder = directory(root)
    pending = folder / (request_id + '.pending.json')
    if pending.is_symlink():
        raise ValueError('拒绝符号链接确认文件。')
    record = json.loads(pending.read_text())
    if time.time() >= record['expires'] or record['digest'] != digest(record['tool'], record['arguments']):
        raise ValueError('确认已过期或内容不一致。')
    print('即将允许一次付费 Sunburst 请求，完整参数如下：')
    print(json.dumps(record['arguments'], ensure_ascii=False, indent=2))
    if not sys.stdin.isatty():
        raise ValueError('必须由用户在交互终端确认，禁止管道批准。')
    if input('确认是你要求的模型及尺寸？输入 APPROVE 批准一次：') != 'APPROVE':
        raise ValueError('未批准。')
    approved = folder / (record['digest'] + '.approved.json')
    if approved.is_symlink():
        raise ValueError('拒绝符号链接确认文件。')
    with approved.open('w') as f:
        os.chmod(approved, 0o600)
        json.dump(record, f, ensure_ascii=False)
    pending.unlink()  # Verified random hex id path in approval directory.
    print('已批准，尚未联网。请原样重发一次请求；批准10分钟内有效。')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('用法：python3 approval.py <请求编号> <工作区>')
        approve(sys.argv[1], Path(sys.argv[2]).expanduser().resolve())
    except (ValueError, OSError) as e:
        sys.exit(str(e))
