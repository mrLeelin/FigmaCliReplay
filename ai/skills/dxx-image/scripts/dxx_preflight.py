"""Offline input header checks before a paid decomposition (standard library only)."""
import hashlib
from pathlib import Path


# Observed upstream rejection threshold; override only for a verified backend change.
MIN_INPUT_PIXELS = 262144
MAX_INPUT_BYTES = 50 * 1024 * 1024


def image_dimensions(path):
    with Path(path).open('rb') as stream:
        header = stream.read(30)
        if header[:8] == b'\x89PNG\r\n\x1a\n' and header[12:16] == b'IHDR' and len(header) >= 24:
            return int.from_bytes(header[16:20], 'big'), int.from_bytes(header[20:24], 'big')
        if header[:4] == b'RIFF' and header[8:12] == b'WEBP':
            stream.seek(12)
            while True:
                chunk = stream.read(8)
                if len(chunk) != 8:
                    break
                length = int.from_bytes(chunk[4:], 'little')
                data = stream.read(min(length, 10))
                if chunk[:4] == b'VP8X' and len(data) == 10:
                    return 1 + int.from_bytes(data[4:7], 'little'), 1 + int.from_bytes(data[7:10], 'little')
                if chunk[:4] == b'VP8 ' and len(data) == 10 and data[3:6] == b'\x9d\x01\x2a':
                    return int.from_bytes(data[6:8], 'little') & 0x3fff, int.from_bytes(data[8:10], 'little') & 0x3fff
                if chunk[:4] == b'VP8L' and len(data) >= 5 and data[0] == 0x2f:
                    bits = int.from_bytes(data[1:5], 'little')
                    return 1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)
                stream.seek(length - len(data) + length % 2, 1)
        if header[:2] == b'\xff\xd8':
            stream.seek(2)
            while True:
                if stream.read(1) != b'\xff':
                    break
                marker = stream.read(1)
                while marker == b'\xff':
                    marker = stream.read(1)
                if not marker or marker in (b'\xd9', b'\xda'):
                    break
                if marker == b'\x01' or 0xd0 <= marker[0] <= 0xd8:
                    continue
                raw_length = stream.read(2)
                if len(raw_length) != 2:
                    break
                length = int.from_bytes(raw_length, 'big')
                if length < 2:
                    break
                if marker[0] in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                    data = stream.read(min(length - 2, 5))
                    if len(data) == 5:
                        return int.from_bytes(data[3:5], 'big'), int.from_bytes(data[1:3], 'big')
                    break
                stream.seek(length - 2, 1)
    raise ValueError('无法读取 PNG/JPEG/WebP 尺寸；未上传、未创建拆层任务。')


def preflight_image(file, min_pixels=MIN_INPUT_PIXELS):
    if not file:
        raise ValueError('Decompose 需要 --file 本地 PNG/JPEG/WebP。')
    path = Path(file).expanduser().resolve()
    if not path.is_file() or path.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.webp'):
        raise ValueError('图片必须是存在的 PNG/JPEG/WebP 文件。')
    size = path.stat().st_size
    if not 0 < size <= MAX_INPUT_BYTES:
        raise ValueError('图片必须非空且不超过 50 MiB。')
    if isinstance(min_pixels, bool) or not isinstance(min_pixels, int) or min_pixels < 1:
        raise ValueError('min-input-pixels 必须为正整数。')
    width, height = image_dimensions(path)
    if min(width, height) < 1 or width * height < min_pixels:
        raise ValueError('图片 %sx%s 仅 %s 像素，拆层至少需要 %s；未上传、未创建任务。请扩大裁切区域并记录坐标变换。'
                         % (width, height, width * height, min_pixels))
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return dict(file=str(path), width=width, height=height, pixels=width * height,
                bytes=size, sha256=digest.hexdigest(), minInputPixels=min_pixels, passed=True)
