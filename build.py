"""Build the installable archive using only the Python standard library."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
output = root / "dist" / "inline_typst.ankiaddon"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in sorted((root / "anki_typst").rglob("*")):
        if path.is_file() and (path.suffix in (".py", ".json", ".md", ".js", ".lua") or path.name == "COPYING"):
            archive.write(path, str(path.relative_to(root / "anki_typst")))
print(output)
