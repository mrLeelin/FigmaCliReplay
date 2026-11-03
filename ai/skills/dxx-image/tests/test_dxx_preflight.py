import contextlib
import hashlib
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
from dxx_preflight import image_dimensions, preflight_image


class DecompositionPreflightTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def image(self, name='source.png', size=(512, 512), **options):
        path = self.root / name
        Image.new('RGB', size, (73, 140, 210)).save(path, **options)
        return path

    def test_supported_headers_match_decoded_dimensions(self):
        cases = [('source.png', {}), ('baseline.jpg', {}),
                 ('progressive.jpg', {'progressive': True}),
                 ('lossy.webp', {}), ('lossless.webp', {'lossless': True})]
        for name, options in cases:
            with self.subTest(name=name):
                path = self.image(name, (721, 512), **options)
                self.assertEqual(image_dimensions(path), (721, 512))
        path = self.root / 'alpha.webp'
        Image.new('RGBA', (721, 512), (73, 140, 210, 127)).save(path)
        self.assertEqual(image_dimensions(path), (721, 512))

    def test_pixel_area_threshold_is_not_a_per_side_minimum(self):
        path = self.image(size=(1024, 256))
        result = preflight_image(path)
        self.assertEqual(result['pixels'], 262144)
        self.assertEqual(result['sha256'], hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertTrue(result['passed'])

    def test_small_crop_is_rejected_before_directory_or_network(self):
        path = self.image(size=(902, 152))
        output = self.root / 'output'
        client = Mock()
        args = SimpleNamespace(action='Decompose', file=str(path), out_dir=str(output), task_id=None)
        with self.assertRaisesRegex(ValueError, '262144'):
            dxx_layers.execute_layers(args, client)
        self.assertEqual(client.mock_calls, [])
        self.assertFalse(output.exists())

    def test_offline_check_never_reads_credentials_or_creates_output(self):
        path = self.image()
        output = self.root / 'output'
        stdout = io.StringIO()
        with patch.object(dxx_image, 'load_config', side_effect=AssertionError('unexpected auth')) as config:
            with contextlib.redirect_stdout(stdout):
                code = dxx_image.main(['Decompose', '--file', str(path), '--check-only', '--out-dir', str(output)])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['width'], 512)
        config.assert_not_called()
        self.assertFalse(output.exists())

    def test_failed_offline_check_leaves_existing_output_untouched(self):
        path = self.image(size=(902, 152))
        with contextlib.redirect_stderr(io.StringIO()):
            code = dxx_image.main(['Decompose', '--file', str(path), '--check-only', '--out-dir', str(self.root)])
        self.assertEqual(code, 1)
        self.assertEqual(list(self.root.iterdir()), [path])

    def test_valid_submission_records_hash_and_does_not_modify_input(self):
        path = self.image()
        before = path.read_bytes()
        output = self.root / 'output'
        args = SimpleNamespace(action='Decompose', file=str(path), out_dir=str(output),
                               task_id=None, prompt='complete resources', size='2K', project_group_id=None)
        client = Mock(base='https://example.com', key='fixture', source=('https', 'example.com', 443))
        client.upload.return_value = 'https://example.com/assets/source.png'
        client.api.return_value = {'taskId': 'fixture-task'}
        with patch.object(dxx_layers, 'wait_layers', return_value={'status': 'completed'}):
            dxx_layers.execute_layers(args, client)
        result = json.loads((output / 'layer-preflight.json').read_text(encoding='utf-8'))
        self.assertEqual(result['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(path.read_bytes(), before)
        client.upload.assert_called_once_with(path)
        self.assertEqual(client.api.call_count, 1)

    def test_invalid_header_and_minimum_fail_locally(self):
        path = self.root / 'bad.png'
        path.write_bytes(b'not an image')
        with self.assertRaises(ValueError):
            preflight_image(path)
        for minimum in (0, -1, True, 1.5):
            with self.subTest(minimum=minimum), self.assertRaises(ValueError):
                preflight_image(self.image(), minimum)


if __name__ == '__main__':
    unittest.main()
