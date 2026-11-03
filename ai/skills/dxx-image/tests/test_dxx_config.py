import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import dxx_config
import dxx_image


class DxxConfigTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'dxx-config.json'

    def write_config(self, value):
        self.path.write_text(json.dumps(value), encoding='utf-8')

    def load(self, env=None, user=None):
        return dxx_config.load_config(self.path, {} if env is None else env,
                                      (lambda name: '') if user is None else user)

    def test_defaults_do_not_require_global_skill_or_environment(self):
        value = self.load()
        self.assertEqual(value['apiBase'], 'https://canvas.dxx.cn')
        self.assertEqual(value['apiKey'], '')
        self.assertEqual(value['keySource'], 'none')
        self.assertEqual(dxx_config.DEFAULT_CONFIG_PATH,
                         SCRIPTS.parents[3] / '.local' / 'dxx-config.json')
        self.assertTrue(dxx_image.local_modules())

    def test_saved_project_settings_override_process_and_user_settings(self):
        self.write_config({'version': 1, 'apiBase': 'https://project.example/',
                           'apiKey': ' saved-project-key '})
        calls = []
        value = self.load({'GORILLA_API_KEY': 'process-key',
                           'GORILLA_API_BASE': 'https://process.example'},
                          lambda name: calls.append(name) or 'user-value')
        self.assertEqual(value['apiKey'], 'saved-project-key')
        self.assertEqual(value['apiBase'], 'https://project.example')
        self.assertEqual(value['keySource'], 'project')
        self.assertEqual(calls, [])

    def test_blank_or_missing_saved_key_falls_back_without_changing_base(self):
        for key in ('', None):
            stored = {'version': 1, 'apiBase': 'https://project.example'}
            if key is not None:
                stored['apiKey'] = key
            self.write_config(stored)
            value = self.load({'GORILLA_API_KEY': 'process-key'})
            self.assertEqual(value['apiKey'], 'process-key')
            self.assertEqual(value['apiBase'], 'https://project.example')
            self.assertEqual(value['keySource'], 'environment')

    def test_process_environment_precedes_windows_user_fallback(self):
        user = {'GORILLA_API_KEY': 'user-key', 'GORILLA_API_BASE': 'https://user.example'}
        value = self.load({'GORILLA_API_KEY': 'process-key'}, user.get)
        self.assertEqual(value['apiKey'], 'process-key')
        self.assertEqual(value['apiBase'], 'https://user.example')
        self.assertEqual(self.load(user=user.get)['apiKey'], 'user-key')

    def test_corrupt_config_and_invalid_types_do_not_silently_use_environment(self):
        invalid = [[], {'version': True}, {'version': 2}, {'version': 1},
                   {'version': 1, 'apiKey': 'saved-key'},
                   {'version': 1, 'apiBase': 'https://project.example', 'apiKey': 123},
                   {'version': 1, 'apiBase': []},
                   {'version': 1, 'apiBase': 'https://project.example', 'apiKey': 'value\nother'},
                   {'version': 1, 'apiBase': 'https://fake-secret@example.com'}]
        for value in invalid:
            self.write_config(value)
            with self.subTest(value=value), self.assertRaises(ValueError) as raised:
                self.load({'GORILLA_API_KEY': 'environment-secret'})
            self.assertNotIn('environment-secret', str(raised.exception))
            self.assertNotIn('fake-secret', str(raised.exception))
        self.path.write_text('{"secret":"do-not-print"', encoding='utf-8')
        with self.assertRaises(ValueError) as raised:
            self.load({'GORILLA_API_KEY': 'environment-secret'})
        self.assertNotIn('do-not-print', str(raised.exception))

    def test_existing_project_file_requires_explicit_api_base(self):
        self.write_config({'version': 1, 'apiKey': 'project-key'})
        with self.assertRaises(ValueError):
            self.load({'GORILLA_API_BASE': 'https://environment.example',
                       'GORILLA_API_KEY': 'environment-key'})

    def test_key_rejects_raw_control_characters_before_trimming(self):
        for value in ('\nsecret', 'secret\r', 'secret\t', 'secret\x00', 'secret\x7f', 'secret other'):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                dxx_config.validate_key(value)
        self.assertEqual(dxx_config.validate_key('  secret  '), 'secret')
        self.assertEqual(dxx_config.validate_key(' '), '')

    def test_invalid_origins_are_rejected_without_echoing_input(self):
        for value in ('http://example.com', 'https://example.com/path',
                      'https://example.com?key=secret', 'https://example.com#secret',
                      'https://secret@example.com', 'https://example.com:bad',
                      'https://example.com?', 'https://example.com#',
                      'https://example.com///', '\nhttps://example.com'):
            with self.subTest(value=value), self.assertRaises(ValueError) as raised:
                dxx_config.validate_api_base(value)
            self.assertNotIn('secret', str(raised.exception))
        self.assertEqual(dxx_config.validate_api_base('https://EXAMPLE.com:443/'),
                         'https://example.com')

    def test_client_uses_resolved_config_instead_of_reading_another_key(self):
        config = {'apiKey': 'project-key', 'apiBase': 'https://project.example'}
        with patch.dict('os.environ', {'GORILLA_API_KEY': 'environment-key'}):
            client = dxx_image.Client(config)
        self.assertEqual(client.key, 'project-key')
        self.assertEqual(client.base, 'https://project.example')

    def test_test_action_only_reads_authenticated_layer_capability(self):
        calls = []
        client = SimpleNamespace(base='https://project.example',
                                 api=lambda *args: calls.append(args) or {
                                     'enabled': True, 'upstream-secret': 'do-not-return'})
        result = dxx_image.execute(SimpleNamespace(action='Test'), client)
        self.assertEqual(calls, [('GET', '/api/v1/layer-decomposition')])
        self.assertEqual(result['ok'], True)
        self.assertNotIn('do-not-return', json.dumps(result))
        self.assertFalse(self.path.exists())

    def test_test_action_uses_fixed_safe_errors(self):
        for failure in (dxx_image.ApiError(401), RuntimeError('raw-secret')):
            def fail(*args):
                raise failure
            client = SimpleNamespace(base='https://project.example', api=fail)
            with self.subTest(failure=type(failure).__name__), self.assertRaises(ValueError) as raised:
                dxx_image.execute(SimpleNamespace(action='Test'), client)
            self.assertNotIn('raw-secret', str(raised.exception))
        for response in ({'enabled': False}, {'enabled': 'yes'}, []):
            client = SimpleNamespace(base='https://project.example', api=lambda *args: response)
            with self.subTest(response=response), self.assertRaises(ValueError):
                dxx_image.execute(SimpleNamespace(action='Test'), client)

    def test_main_redacts_actual_project_key_from_results_and_failures(self):
        secret = 'fake-project-secret'
        config = {'apiKey': secret, 'apiBase': 'https://project.example'}
        for response in ({'value': secret}, RuntimeError('error: ' + secret)):
            stdout, stderr = io.StringIO(), io.StringIO()
            effect = {'side_effect': response} if isinstance(response, Exception) else {'return_value': response}
            with patch.object(dxx_image, 'load_config', return_value=config), \
                    patch.object(dxx_image, 'execute', **effect), \
                    contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = dxx_image.main(['Test'])
            combined = stdout.getvalue() + stderr.getvalue()
            self.assertNotIn(secret, combined)
            self.assertIn('[REDACTED]', combined)
            self.assertEqual(code, 1 if isinstance(response, Exception) else 0)


if __name__ == '__main__':
    unittest.main()
