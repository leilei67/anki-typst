"""The small boundary between the editor bridge and the Typst compiler."""

import base64
import json
import struct

from .compiler import compile_snippet


def parse_request(message: str) -> dict:
    request = json.loads(message)
    if not isinstance(request, dict):
        raise ValueError("Expected an object")
    if type(request.get("id")) is not int or not 0 < request["id"] < 2**53:
        raise ValueError("Invalid request id")
    if not isinstance(request.get("source"), str) or len(request["source"]) > 50000:
        raise ValueError("Invalid or oversized source")
    return request


def compile_preview(source: str, compiler_path: str = "") -> dict:
    name, data = compile_snippet(source, compiler_path)
    width, height = struct.unpack(">II", data[16:24])
    return {
        "name": name,
        "png": data,
        "url": "data:image/png;base64," + base64.b64encode(data).decode("ascii"),
        "width": width / 2,
        "height": height / 2,
    }
