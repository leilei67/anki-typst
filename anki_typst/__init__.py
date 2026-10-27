"""Anki entry point."""


def register():
    import json
    import weakref
    from pathlib import Path

    from aqt import gui_hooks, mw
    from aqt.editor import Editor, NewEditor

    from .compiler import snippet_name
    from .live import compile_preview, parse_request

    javascript = Path(__file__).with_name("editor.js").read_text(encoding="utf-8")

    def initialize(editor):
        editor.web.eval(javascript)

    def buttons(buttons, editor):
        buttons.append(editor.addButton(
            icon=None, cmd="inline_typst", label="Typst",
            func=lambda ed: ed.web.eval(
                "wrap('[typst]$', '$[/typst]');"
                "setTimeout(() => window.inlineTypst?.scan(true), 0);"
            ),
            tip="Insert inline Typst math. Click a formula to edit its source.",
            keys="Ctrl+M, T",
        ))

    def message(handled, text, context):
        if not text.startswith("inline-typst:") or not isinstance(context, (Editor, NewEditor)):
            return handled
        try:
            request = parse_request(text[len("inline-typst:"):])
        except (ValueError, TypeError, KeyError):
            return (True, None)
        collection = mw.col
        if collection is None:
            return (True, None)
        config = mw.addonManager.getConfig(__name__) or {}
        editor_ref = weakref.ref(context)

        def done(future):
            # An editor can disappear, or the profile can close, during compilation.
            if mw.col is not collection:
                return
            try:
                result = future.result()
                filename = collection.media.write_data(result.pop("name"), result.pop("png"))
                result["filename"] = filename
            except Exception as error:
                result = {"error": str(error)}
            editor = editor_ref()
            if editor is not None and editor.web is not None:
                try:
                    editor.web.eval(
                        "window.inlineTypst?.receive("
                        f"{request['id']}, {json.dumps(result)});"
                    )
                except RuntimeError:
                    pass  # The Qt web view may already have been destroyed.

        mw.taskman.run_in_background(
            lambda: compile_preview(request["source"], config.get("compiler_path", "")),
            done, uses_collection=False,
        )
        return (True, {"filename": snippet_name(request["source"])})

    gui_hooks.editor_did_init.append(initialize)
    gui_hooks.editor_did_load_note.append(initialize)
    gui_hooks.editor_did_init_buttons.append(buttons)
    gui_hooks.webview_did_receive_js_message.append(message)


try:
    import aqt
except ImportError:
    pass
else:
    register()
