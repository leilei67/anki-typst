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
- Press **Ctrl/⌘+Enter**, click **×**, or click outside to close the source editor.
  There is no separate Render step. With Vim enabled, **Escape** enters Normal
  mode and **Tab** follows your Neovim bindings.
- Typing **$** in the source editor inserts **$$** with the caret between them.
  Typing **$** before its closing partner skips over it. Backspace removes an
  empty pair. Escaped dollars and pasted text are left alone.
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
they are recompiled once to remove their old white background.

## Your Neovim keybindings

Vim input is enabled by default. A headless instance of your installed Neovim
handles keystrokes while the popup keeps Anki's appearance. Neovim loads your
normal config, including **`~/.config/nvim/init.vim`** on this Mac. Your `jk`
mapping and delete mappings run in Neovim itself; config colors and line-number
styling are not copied into the popup.

The source editor starts in Insert mode. **Escape** or your **jk** mapping enters
Normal mode. The header shows the current mode. Regular motions, operators,
visual selections, undo, and your configured mappings use the real Neovim engine.
The add-on adds buffer-local dollar/backspace pairing without changing config files.

If AnkiVim is installed, its keyboard filter is temporarily suspended while this
popup handles input and restored on closing. If Neovim fails to start, an inline
error appears and the popup remains usable as a plain source editor.

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

- `vim_enabled`: defaults to `true`; set `false` for the plain source editor.
- `nvim_path`: leave empty for automatic discovery, including Homebrew, or give
  the absolute path to Neovim.
- `vimrc_path`: leave empty for Neovim's standard config. Set a full file path
  only to override it. Reopen the popup after changing your mappings.

- Formula backgrounds are transparent, so Anki's actual background shows through.
  Dark-mode theme rules make the formula light on dark backgrounds in the editor
  and saved cards. Images scale with surrounding text.
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
profile closure, transparent PNG output, dollar pairing, real Neovim mappings,
and real Typst compilation. DOM tests simulate the editor's
shadow roots; they do not replace an interactive GUI check. A real browser could
not launch in the restricted build environment. Physical mobile syncing has not
been tested.

API references: [Anki editor hooks](https://github.com/ankitects/anki/blob/26.09.3/qt/tools/genhooks_gui.py),
[Anki editor implementation](https://github.com/ankitects/anki/blob/26.09.3/qt/aqt/editor.py),
[Anki frontend](https://github.com/ankitects/anki/tree/26.09.3/ts),
[Anki media API](https://github.com/ankitects/anki/blob/26.09.3/pylib/anki/media.py).

Neovim uses its [embedded RPC interface](https://neovim.io/doc/user/api/).
The bundled MessagePack 1.1.2 Python fallback comes from `msgpack-python`,
under the Apache 2.0 license; its copyright notice is in `anki_typst/msgpack/COPYING`.
