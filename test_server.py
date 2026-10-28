import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('server', Path(__file__).with_name('server.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=')


class Tests(unittest.TestCase):
    def test_stdio(self):
        requests = [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2024-11-05', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
            {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'status'}},
        ]
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('server.py'))], input=''.join(json.dumps(r) + '\n' for r in requests), text=True, capture_output=True, check=True)
        rows = [json.loads(x) for x in result.stdout.splitlines()]
        self.assertEqual(len(rows), 3)
        self.assertEqual(len(rows[1]['result']['tools']), 3)
        self.assertNotIn('error', rows[0])

    def test_portable_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'status'}}
            env = dict(os.environ, YOMI_WORKSPACE=str(root))
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('server.py'))],
                                    input=json.dumps(request) + '\n', text=True, capture_output=True,
                                    env=env, check=True)
            status = json.loads(json.loads(result.stdout)['result']['content'][0]['text'])
            self.assertEqual(status['workspace'], str(root))
            self.assertEqual(status['default_model'], 'gpt-image-2.5')
            self.assertEqual(list(root.iterdir()), [])

    def test_ratio_does_not_inject_size(self):
        with patch.object(s, 'api', return_value={}) as api, patch.object(s, 'save_response', return_value={}):
            for ratio in ('3:4', '16:9', '1:1', '9:16'):
                s.call('generate_image', {'prompt': '产品展示图，比例' + ratio})
                fields = json.loads(api.call_args.args[1])
                self.assertNotIn('size', fields)
                self.assertEqual(fields['model'], 'gpt-image-2.5')

    def test_generation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(s, 'ROOT', Path(tmp).resolve()), patch.object(s, 'OUT', Path(tmp)/'output'), patch.object(s, 'api', return_value={'data': [{'b64_json': base64.b64encode(PNG).decode()}]}) as api:
            result = s.call('generate_image', {'prompt': 'cat', 'size': '3840x2160', 'quality': 'max'})
            self.assertEqual(api.call_args.args[0], '/images/generations')
            payload = json.loads(api.call_args.args[1])
            self.assertEqual(payload['model'], 'gpt-image-2.5-sunburst')
            self.assertEqual(payload['size'], '3840x2160')
            self.assertEqual(payload['quality'], 'max')
            self.assertEqual(result['content'][1]['mimeType'], 'image/png')
            self.assertEqual(len(list((Path(tmp)/'output').iterdir())), 1)

    def test_resolution_model_routing(self):
        self.assertEqual(s.select_model({'prompt': '生成一张猫'}), 'gpt-image-2.5')
        self.assertEqual(s.select_model({'prompt': '生成一张 1K 图片'}), 'gpt-image-2.5')
        self.assertEqual(s.select_model({'prompt': '生成一张 2K 图片'}), 'gpt-image-2.5-sunburst')
        self.assertEqual(s.select_model({'prompt': '生成一张 4K 图片'}), 'gpt-image-2.5-sunburst')
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'size': '1536x1024'}), 'gpt-image-2.5')
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'size': '1536x2048'}), 'gpt-image-2.5-sunburst')
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'size': '2048x2048'}), 'gpt-image-2.5-sunburst')
        for ratio in ('1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '1:3', '3:1', '21:9', '9：16', '4∶5', '正方形', '竖版', '横版'):
            self.assertEqual(s.select_model({'prompt': '生成一张图，比例 ' + ratio}), 'gpt-image-2.5', ratio)
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'size': '1536x1536'}), 'gpt-image-2.5')
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'size': '1552x1024'}), 'gpt-image-2.5-sunburst')
        self.assertEqual(s.select_model({'prompt': '生成一张图', 'model': 'gpt-image-2.5'}), 'gpt-image-2.5')

    def test_edit(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(s, 'ROOT', Path(tmp).resolve()), patch.object(s, 'save_response', return_value={'content': []}), patch.object(s, 'api', return_value={}) as api:
            (Path(tmp)/'ref.png').write_bytes(PNG)
            s.call('edit_image', {'prompt': 'blue background', 'image_paths': ['ref.png']})
            self.assertEqual(api.call_args.args[0], '/images/edits')
            self.assertIn(b'name="image"', api.call_args.args[1])
            self.assertIn(PNG, api.call_args.args[1])

    def test_model_and_size_validation(self):
        invalid = [
            {'prompt': 'cat', 'size': '4096x4096'},
            {'prompt': 'cat', 'size': '3000x1000'},
            {'prompt': 'cat', 'size': '1025x1024'},
            {'prompt': 'cat', 'model': 'unknown'},
            {'prompt': 'cat', 'quality': 'max', 'model': 'gpt-image-2.5'},
        ]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(ValueError):
                s.call('generate_image', args)
        valid = s.call
        with patch.object(s, 'api', return_value={'data': [{'b64_json': base64.b64encode(PNG).decode()}]}), patch.object(s, 'OUT', Path('/tmp/yomi-image-test-output')):
            # Payload validation happens before invoking the mocked endpoint.
            with self.assertRaises(ValueError):
                valid('generate_image', {'prompt': 'cat', 'size': '1025x1024'})

    def test_guards(self):
        with self.assertRaises(ValueError):
            s.local_image('/etc/passwd')
        with self.assertRaises(ValueError):
            s.public_https('http://example.com/a.png')
        with self.assertRaises(ValueError):
            s.public_https('https://127.0.0.1/a.png')
        with self.assertRaises(ValueError):
            s.call('generate_image', {'prompt': ''})
        with self.assertRaises(ValueError):
            s.image_type(b'not an image')

    def test_secret_permissions(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'key'
            p.write_text('test-only-not-a-real-key')
            p.chmod(0o644)
            with patch.object(s, 'KEY_FILE', p):
                with self.assertRaises(ValueError):
                    s.key()
                p.chmod(0o600)
                self.assertEqual(s.key(), 'test-only-not-a-real-key')


if __name__ == '__main__':
    unittest.main()
