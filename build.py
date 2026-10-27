"""Build the installable archive using only the Python standard library."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
output = root / "dist" / "inline_typst.ankiaddon"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for path in sorted((root / "anki_typst").iterdir()):
        if path.is_file() and path.suffix in (".py", ".json", ".md", ".js"):
            archive.write(path, path.name)
print(output)
