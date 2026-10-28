#!/usr/bin/env python3
"""Run locally in Terminal; input is hidden and never logged."""
import getpass
import os
from pathlib import Path
import stat

root = Path(os.environ.get('YOMI_WORKSPACE', str(Path.home() / 'dshwork'))).expanduser().resolve()
directory = root / '.secrets'
if directory.is_symlink():
    raise SystemExit('拒绝使用符号链接密钥目录。')
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
p = directory / 'yomi-image-key'
if p.is_symlink():
    raise SystemExit('拒绝使用符号链接密钥文件。')
secret = getpass.getpass('请输入新生成的生图分组 API Key（隐藏输入）：').strip()
if not secret or any(c.isspace() for c in secret):
    raise SystemExit('密钥为空或含空白，未保存。')
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as f:
    os.fchmod(f.fileno(), stat.S_IRUSR | stat.S_IWUSR)
    f.write(secret + '\n')
print('已在本机保存密钥，权限 600；未调用 API。')
