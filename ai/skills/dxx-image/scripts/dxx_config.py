"""Read the same local DXX settings as the Relay settings page, without logging secrets."""
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

DEFAULT_API_BASE = 'https://canvas.dxx.cn'
DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[4] / '.local' / 'dxx-config.json'


def windows_user_value(name):
    if sys.platform != 'win32':
        return ''
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as key:
            value = winreg.QueryValueEx(key, name)[0]
        return value if isinstance(value, str) else ''
    except OSError:
        return ''


def validate_key(value):
    if not isinstance(value, str) or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError('DXX Key 必须是字符串。')
    value = value.strip()
    if len(value) > 8192 or re.search(r'\s', value):
        raise ValueError('DXX Key 格式无效，请检查空格、换行或长度。')
    return value


def validate_api_base(value):
    if not isinstance(value, str) or re.search(r'[\x00-\x1f\x7f]', value):
        raise ValueError('DXX API 地址必须是字符串。')
    value = value.strip()
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (len(value) > 2048 or parsed.scheme != 'https' or not parsed.hostname
                or parsed.username or parsed.password or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or '?' in value or '#' in value
                or re.search(r'\s', value)):
            raise ValueError()
        host = parsed.hostname.lower()
        if ':' in host:
            host = '[' + host + ']'
        return 'https://' + host + (':' + str(port) if port is not None and port != 443 else '')
    except (ValueError, UnicodeError):
        raise ValueError('DXX API 地址必须是无凭证、路径和查询参数的 HTTPS 源站。') from None


def load_config(config_path=None, environ=None, user_env=None):
    """Project values take priority over process env, Windows user env, and defaults.

    Blank or absent project apiKey intentionally falls back to the environment.
    Tests may pass mappings/callables so no credentials or registry reads are needed.
    """
    config_path = Path(config_path) if config_path is not None else DEFAULT_CONFIG_PATH
    environ = os.environ if environ is None else environ
    user_env = windows_user_value if user_env is None else user_env
    stored = {}
    if config_path.exists():
        try:
            stored = json.loads(config_path.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError, UnicodeError):
            raise ValueError('DXX 本地配置无法读取，请在设置中重新保存。') from None
        if (not isinstance(stored, dict) or type(stored.get('version')) is not int
                or stored['version'] != 1 or not isinstance(stored.get('apiBase'), str)):
            raise ValueError('DXX 本地配置格式无效，请在设置中重新保存。')
        if 'apiKey' in stored:
            validate_key(stored['apiKey'])
        validate_api_base(stored['apiBase'])
    project_key = validate_key(stored.get('apiKey', ''))
    process_key = environ.get('GORILLA_API_KEY', '')
    key = project_key or process_key or user_env('GORILLA_API_KEY') or ''
    key_source = 'project' if project_key else ('environment' if key else 'none')
    base = (stored.get('apiBase') or environ.get('GORILLA_API_BASE')
            or user_env('GORILLA_API_BASE') or DEFAULT_API_BASE)
    return {'apiBase': validate_api_base(base), 'apiKey': validate_key(key),
            'keySource': key_source, 'configPath': str(config_path.resolve())}
