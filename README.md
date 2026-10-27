# Inline Typst for Anki

Inline Typst with a live source editor, similar to Anki's inline MathJax.

## Install or update

1. In desktop Anki, open **Tools → Add-ons → Install from file**.
2. Select [`dist/inline_typst.ankiaddon`](dist/inline_typst.ankiaddon). This updates
   the earlier Inline Typst add-on under the same package name.
3. Restart Anki.

Requires a local [Typst CLI](https://github.com/typst/typst#installation).
Homebrew's `/opt/homebrew/bin/typst` is discovered automatically on this Mac.
The integration targets Anki **26.9.3** and its `RichTextInput` editor API.

## Use

- Click **Typst**, or press **Ctrl+M, T** (**⌘+M, T** on macOS), to insert a formula
  and open its source editor. The `$...$` math delimiters are already included.
- Type inside the source editor. The inline formula updates after a **200 ms**
  pause, plus the time Typst takes to compile. Compilation runs in the background.
- Click any existing formula to edit it again. Source stays editable after saving
  and reopening a card.
- Press **Escape**, **Tab**, or **Ctrl/⌘+Enter**, or click outside, to close the
  source editor. There is no separate Render step.
- You can also type `[typst]$x^2$[/typst]` directly into a field. Complete tags
  turn into a clickable inline formula automatically. Type tags as plain text;
  don't apply rich-text formatting inside them. The popup supports multiline source.

Examples of source to enter in the popup:

```typst
$frac(a, b)$
```

```typst
$a^2 + b^2 = c^2$
```

```typst
#text(weight: "bold")[Remember this]
```

Existing images made with the first version become clickable formulas when
opened in the editor. Their original Typst source is recovered automatically;
there is no manual HTML editing step.

## Saved cards and mobile

The note stores both the source and an ordinary PNG media reference. The editor's
live preview is temporary; no base64 image data is saved in your fields.
After syncing notes and media, the image displays on AnkiMobile and AnkiDroid
without this add-on. Creating or editing Typst still requires desktop Anki.

Finish typing and let the preview update before adding the card or syncing.
Compiler errors appear beside the source without interrupting typing. Invalid
source is retained, along with the last good image if one exists. Fix the error
before saving if you want the image to match the source.

## Configuration and limits

In **Tools → Add-ons → Inline Typst → Config**, leave `compiler_path` empty for
automatic discovery, or enter the absolute path to the `typst` executable.

- Rendering uses black text on a tightly cropped white background, so it stays
  legible in light and dark themes. Images scale with surrounding text.
- Each snippet is a standalone Typst document. Files outside its temporary root
  are inaccessible. Multipage output is unsupported. Compilation times out after
  15 seconds per snippet. Source is limited to 50,000 characters.
- Successful previews are saved as media so cards can sync immediately. Different
  intermediate formulas can leave unused images; Anki's **Check Media** can find
  these. Identical compiled output is reused by Anki's media API.
- Keep cloze markers around the entire formula, outside its Typst source.
- The compiler caches 64 snippets in memory. Restart Anki after changing compiler
  versions or fonts to clear the cache.
- This is an editor extension. Raw snippets in imported notes need to be opened
  in the desktop editor to generate their images.

## Build and validation

```sh
python3 -m unittest discover -s tests -v
node --test tests/editor.test.cjs
python3 build.py
```

The JavaScript behavior tests use `linkedom` (a development-only dependency;
provide it through `NODE_PATH` if it is installed elsewhere). Optional Python
integration tests run when Anki's `aqt` libraries are on `PYTHONPATH`, using a
compatible Python version. The installed Anki 26.9.3 bundles Python 3.13.

Validation covers live updates, debouncing, stale results, inline errors, the
native editor mirror guard, old-image migration, reopened formulas, media saving,
profile closure, and real Typst compilation. DOM tests simulate the editor's
shadow roots; they do not replace an interactive GUI check. A real browser could
not launch in the restricted build environment. Physical mobile syncing has not
been tested.

API references: [Anki editor hooks](https://github.com/ankitects/anki/blob/26.09.3/qt/tools/genhooks_gui.py),
[Anki editor implementation](https://github.com/ankitects/anki/blob/26.09.3/qt/aqt/editor.py),
[Anki frontend](https://github.com/ankitects/anki/tree/26.09.3/ts),
[Anki media API](https://github.com/ankitects/anki/blob/26.09.3/pylib/anki/media.py).
