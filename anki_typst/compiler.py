"""Compile self-contained Typst snippets without depending on Anki."""

import hashlib
import shutil
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path


class CompileError(Exception):
    pass


PREAMBLE = """#set page(width: auto, height: auto, margin: 2pt, fill: white)
#set text(size: 18pt, fill: black)
"""


def find_compiler(configured: str = "") -> str:
    candidates = [configured] if configured else [
        "typst", "/opt/homebrew/bin/typst", "/usr/local/bin/typst",
        str(Path.home() / ".cargo" / "bin" / "typst"),
    ]
    for candidate in candidates:
        executable = shutil.which(candidate)
        if executable:
            return executable
    raise CompileError(
        "Typst was not found. Install the Typst CLI, or set compiler_path "
        "in Tools → Add-ons → Inline Typst → Config."
    )


def snippet_name(source: str) -> str:
    return "typst-" + hashlib.sha256((PREAMBLE + source).encode()).hexdigest() + ".png"


@lru_cache(maxsize=64)
def compile_snippet(source: str, compiler_path: str = "") -> tuple[str, bytes]:
    document = PREAMBLE + source
    name = snippet_name(source)
    compiler = find_compiler(compiler_path)
    with tempfile.TemporaryDirectory(prefix="anki-typst-") as directory:
        root = Path(directory)
        input_file = root / "snippet.typ"
        output_file = root / "snippet.png"
        input_file.write_text(document, encoding="utf-8")
        try:
            result = subprocess.run(
                [compiler, "compile", "--root", directory, "--format", "png",
                 "--ppi", "192", str(input_file), str(output_file)],
                cwd=directory, capture_output=True, timeout=15,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as error:
            raise CompileError("Typst compilation exceeded 15 seconds.") from error
        except OSError as error:
            raise CompileError(f"Could not start Typst: {error}") from error
        if result.returncode:
            raise CompileError(result.stderr.decode("utf-8", errors="replace")[:4000])
        if not output_file.is_file():
            raise CompileError("Typst did not produce an image.")
        return name, output_file.read_bytes()
