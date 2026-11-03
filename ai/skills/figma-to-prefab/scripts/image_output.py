"""Deterministic PNG output shared by download planning and image writing."""

from io import BytesIO


def prepare_png_bytes(raw, expected_size=None):
    """Crop oversized PNGs; keep original bytes for every untransformed image."""
    if not expected_size or min(expected_size) <= 0:
        return raw
    if len(raw) < 24 or raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        return raw
    width = int.from_bytes(raw[16:20], "big")
    height = int.from_bytes(raw[20:24], "big")
    expected_width, expected_height = expected_size
    if (width, height) == (expected_width, expected_height):
        return raw
    if width < expected_width or height < expected_height:
        return raw

    from PIL import Image

    output = BytesIO()
    with Image.open(BytesIO(raw)) as image:
        image.crop((0, 0, expected_width, expected_height)).save(output, format="PNG")
    return output.getvalue()
