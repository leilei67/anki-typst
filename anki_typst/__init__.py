"""Anki entry point."""


def register():
    import json
    import sys
    import weakref
    from pathlib import Path

    from aqt import gui_hooks, mw
    from aqt.editor import Editor, NewEditor

    from .compiler import snippet_name
    from .live import compile_preview, parse_request
    from .vim import VimBridge

    javascript = Path(__file__).with_name("editor.js").read_text(encoding="utf-8")
    vim_bridges = weakref.WeakKeyDictionary()
    vim_restores = weakref.WeakKeyDictionary()

    def initialize(editor):
        config = mw.addonManager.getConfig(__name__) or {}
        editor.web.eval(
            "window.inlineTypstConfig = " + json.dumps({"vimEnabled": config.get("vim_enabled", True)})
            + ";" + javascript
        )

    def suspend_ankivim(editor):
        # AnkiVim's Qt filter otherwise consumes keys before the popup receives them.
        addon = sys.modules.get("978943807")
        pair = getattr(addon, "active_vim_instances", {}).get(id(editor))
        if not pair:
            return lambda: None
        _, interceptor = pair
        targets = [editor.web.focusProxy() or editor.web, editor.parentWindow]
        for target in targets:
            if target is not None:
                target.removeEventFilter(interceptor)

        def restore():
            for target in targets:
                if target is not None:
                    try:
                        target.installEventFilter(interceptor)
                    except RuntimeError:
                        pass
        return restore

    def vim_message(text, context):
        try:
            request = json.loads(text[len("inline-typst-vim:"):])
            if not isinstance(request, dict) or request.get("action") not in ("start", "keys", "stop"):
                raise ValueError()
            if type(request.get("session")) is not int or request["session"] <= 0:
                raise ValueError()
            if request["action"] == "start":
                if not isinstance(request.get("source"), str) or len(request["source"]) > 50000:
                    raise ValueError()
            if "keys" in request and (not isinstance(request["keys"], str) or len(request["keys"]) > 10000):
                raise ValueError()
            if "paste" in request and (not isinstance(request["paste"], str) or len(request["paste"]) > 50000):
                raise ValueError()
            if "cursor" in request:
                cursor = request["cursor"]
                if not isinstance(cursor, list) or len(cursor) != 2 or any(type(n) is not int for n in cursor):
                    raise ValueError()
                if cursor[0] < 1 or cursor[1] < 0:
                    raise ValueError()
            if request["action"] == "start" and "cursor" not in request:
                raise ValueError()
        except (ValueError, TypeError):
            return (True, None)
        config = mw.addonManager.getConfig(__name__) or {}
        if not config.get("vim_enabled", True):
            return (True, None)
        if context not in vim_bridges:
            bridge = VimBridge()
            vim_bridges[context] = bridge
            if getattr(context, "widget", None) is not None:
                context.widget.destroyed.connect(lambda *_: bridge.close())
        editor_ref = weakref.ref(context)

        def deliver(session, result):
            def update():
                editor = editor_ref()
                if editor is None or editor.web is None:
                    return
                try:
                    editor.web.eval(
                        f"window.inlineTypst?.vimReceive({session}, {json.dumps(result)});"
                    )
                except RuntimeError:
                    pass
            mw.taskman.run_on_main(update)

        if request["action"] == "start":
            vim_restores.pop(context, lambda: None)()
            vim_restores[context] = suspend_ankivim(context)
        elif request["action"] == "stop":
            vim_restores.pop(context, lambda: None)()
        vim_bridges[context].dispatch(request, config, deliver)
        return (True, None)

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
        if not isinstance(context, (Editor, NewEditor)):
            return handled
        if text.startswith("inline-typst-vim:"):
            return vim_message(text, context)
        if not text.startswith("inline-typst:"):
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
