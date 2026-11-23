import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import dxx_image
import dxx_layers
from dxx_preflight import preflight_image


class LayerModelOptionTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def image(self, name='source.png', size=(512, 512)):
        path = self.root / name
        Image.new('RGB', size, (73, 140, 210)).save(path)
        return path

    def submit(self, path, **options):
        output = self.root / 'output'
        values = dict(action='Decompose', file=str(path), out_dir=str(output), task_id=None,
                      prompt=None, size=None, project_group_id=None)
        values.update(options)
        client = Mock(base='https://example.com', key='fixture', source=('https', 'example.com', 443))
        client.upload.return_value = 'https://example.com/assets/source.png'
        client.api.return_value = {'taskId': 'fixture-task'}
        with patch.object(dxx_layers, 'wait_layers', return_value={'status': 'completed'}):
            dxx_layers.execute_layers(SimpleNamespace(**values), client)
        return client.api.call_args[0][2], output

    def test_default_request_body_is_unchanged(self):
        body, _ = self.submit(self.image())
        self.assertEqual(body, {'image': 'https://example.com/assets/source.png', 'size': '1K'})

    def test_seedream55_sends_model_and_options(self):
        body, output = self.submit(self.image(), model='seedream55', max_images=12,
                                   text_recognition=True, output_format='jpeg')
        self.assertEqual(body, {'image': 'https://example.com/assets/source.png', 'size': 'auto',
                                'model': 'seedream55', 'maxImages': 12, 'textRecognition': True,
                                'outputFormat': 'jpeg'})
        record = json.loads((output / 'layer-request.json').read_text(encoding='utf-8'))
        self.assertEqual(record['body'], body)

    def test_explicit_seedream50pro_is_sent(self):
        body, _ = self.submit(self.image(), model='seedream50pro', size='2K')
        self.assertEqual(body['model'], 'seedream50pro')
        self.assertEqual(body['size'], '2K')

    def test_invalid_options_fail_before_directory_or_network(self):
        cases = [
            dict(size='auto'),
            dict(model='seedream50pro', size='auto'),
            dict(max_images=10),
            dict(text_recognition=True),
            dict(output_format='png'),
            dict(model='seedream55', max_images=1),
            dict(model='seedream55', max_images=65),
            dict(model='seedream55', max_images=True),
            dict(model='seedream60'),
        ]
        path = self.image()
        for options in cases:
            with self.subTest(options=options):
                output = self.root / 'output'
                values = dict(action='Decompose', file=str(path), out_dir=str(output), task_id=None,
                              prompt=None, size=None, project_group_id=None)
                values.update(options)
                client = Mock()
                with self.assertRaises(ValueError):
                    dxx_layers.execute_layers(SimpleNamespace(**values), client)
                self.assertEqual(client.mock_calls, [])
                self.assertFalse(output.exists())

    def test_seedream55_rejects_webp_and_disguised_webp(self):
        webp = self.image('source.webp')
        with self.assertRaisesRegex(ValueError, 'PNG/JPEG'):
            preflight_image(webp, model='seedream55')
        disguised = self.root / 'disguised.png'
        disguised.write_bytes(webp.read_bytes())
        with self.assertRaises(ValueError):
            preflight_image(disguised, model='seedream55')
        self.assertTrue(preflight_image(webp)['passed'])

    def test_seedream55_pixel_and_byte_limits(self):
        large = self.image('large.png', (6001, 6000))
        with self.assertRaisesRegex(ValueError, '36000000'):
            preflight_image(large, model='seedream55')
        self.assertTrue(preflight_image(large)['passed'])
        with patch('dxx_preflight.MODEL_INPUT_LIMITS', {'seedream55': dict(
                suffixes=('.png',), kinds=('png',), max_bytes=10, max_pixels=36000000)}):
            with self.assertRaisesRegex(ValueError, '字节'):
                preflight_image(self.image(), model='seedream55')

    def test_offline_check_applies_model_limits(self):
        webp = self.image('source.webp')
        with contextlib.redirect_stderr(io.StringIO()), \
                patch.object(dxx_image, 'load_config', side_effect=AssertionError('unexpected auth')):
            code = dxx_image.main(['Decompose', '--file', str(webp), '--check-only', '--model', 'seedream55'])
        self.assertEqual(code, 1)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = dxx_image.main(['Decompose', '--file', str(self.image()), '--check-only', '--model', 'seedream55'])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['model'], 'seedream55')

    def test_client_timeout_after_submission_reports_the_saved_task_id(self):
        output = self.root / 'output'

        def submit_then_time_out(args, client):
            output.mkdir()
            (output / 'layer-task-id.txt').write_text('d7ab5773-bb08-434e-8c1f-d571416d31f0', encoding='utf-8')
            raise TimeoutError('等待已停止，服务端任务未必失败；使用 Layerwait 和相同 taskId 恢复。')

        client = Mock(timings={})
        stderr = io.StringIO()
        with patch.object(dxx_image, 'load_config', return_value={'apiKey': 'fixture-key'}), \
                patch.object(dxx_image, 'Client', return_value=client), \
                patch.object(dxx_layers, 'execute_layers', side_effect=submit_then_time_out), \
                contextlib.redirect_stderr(stderr):
            code = dxx_image.main(['Decompose', '--file', str(self.image()), '--model', 'seedream55',
                                   '--out-dir', str(output), '--timeout-seconds', '90'])
        self.assertEqual(code, 2)
        error = json.loads((output / 'error.json').read_text(encoding='utf-8'))
        self.assertEqual(error['taskId'], 'd7ab5773-bb08-434e-8c1f-d571416d31f0')
        self.assertIn('taskId=d7ab5773-bb08-434e-8c1f-d571416d31f0', stderr.getvalue())

    def test_failure_before_submission_keeps_task_id_empty(self):
        output = self.root / 'output'
        output.mkdir()
        # A module task ID in the same directory must not be reported for a decomposition.
        (output / 'task-id.txt').write_text('other-module-task', encoding='utf-8')
        client = Mock(timings={})
        stderr = io.StringIO()
        with patch.object(dxx_image, 'load_config', return_value={'apiKey': 'fixture-key'}), \
                patch.object(dxx_image, 'Client', return_value=client), \
                patch.object(dxx_layers, 'execute_layers', side_effect=ValueError('上传失败')), \
                contextlib.redirect_stderr(stderr):
            code = dxx_image.main(['Decompose', '--file', str(self.image()), '--out-dir', str(output)])
        self.assertEqual(code, 1)
        self.assertIsNone(json.loads((output / 'error.json').read_text(encoding='utf-8'))['taskId'])
        self.assertNotIn('taskId=', stderr.getvalue())


if __name__ == '__main__':
    unittest.main()
