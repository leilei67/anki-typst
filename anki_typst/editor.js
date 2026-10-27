(() => {
    if (window.inlineTypst) {
        window.inlineTypst.scan();
        return;
    }
    const tag = "anki-typst";
    const pending = new Map();
    const roots = new WeakSet();
    const fields = new Set();
    const inputAPIs = new WeakMap();
    let nextId = 0;
    let active = null;
    let scanTimer;
    let vimSession = 0;
    const imageFormat = "transparent-v1";
    const darkThemes = [".nightMode", ".night_mode", ".night-mode"];
    const savedTheme = 'anki-typst>img.typst-transparent{filter:none}' +
        darkThemes.map((theme) => `${theme} anki-typst>img.typst-transparent`).join(",") +
        '{filter:invert(1)}';

    // Use the same mirror guard as Anki's MathJax popup, so source edits do not
    // rebuild the field (and remove the formula) when the popup takes focus.
    try {
        const native = require("anki/RichTextInput");
        const track = (api) => { api.element.then((element) => inputAPIs.set(element, api)); };
        native.instances.forEach(track);
        native.lifecycle.onMount(track);
    } catch {
        // The native API is unavailable in standalone DOM tests.
    }

    function notify(element) {
        const field = element.closest('[contenteditable="true"]');
        field?.dispatchEvent(new InputEvent("input", {
            bubbles: true, composed: true, inputType: "insertReplacementText",
        }));
    }

    function request(source, callback, acknowledge) {
        const id = ++nextId;
        pending.set(id, callback);
        pycmd("inline-typst:" + JSON.stringify({ id, source }), acknowledge);
    }

    function imageStyle(image, width, height) {
        image.classList.add("typst-transparent");
        image.setAttribute("width", String(width));
        image.setAttribute("height", String(height));
        image.style.cssText = `width:${width / 24}em;height:${height / 24}em;` +
            "max-width:100%;object-fit:contain;vertical-align:middle;";
    }

    class Typst extends HTMLElement {
        connectedCallback() {
            if (this.preview) return;
            this.source = this.getAttribute("data-source") || "";
            this.setAttribute("contenteditable", "false");
            this.style.cssText = "display:inline-block;vertical-align:middle;cursor:pointer;";
            const shadow = this.attachShadow({ mode: "open" });
            shadow.innerHTML = '<style>:host{line-height:normal}img{vertical-align:middle;' +
                'background:transparent}' + darkThemes.map((theme) => `:host-context(${theme}) img`).join(",") +
                '{filter:invert(1)}span{font:inherit;opacity:.6}:host(:focus){outline:1px solid Highlight}' +
                '</style><img hidden><span>Typst…</span>';
            if (!this.querySelector("style[data-typst-theme]")) {
                const theme = document.createElement("style");
                theme.setAttribute("data-typst-theme", "");
                theme.textContent = savedTheme;
                this.append(theme);
            }
            this.preview = shadow.querySelector("img");
            this.preview.addEventListener("error", () => this.schedule());
            this.placeholder = shadow.querySelector("span");
            for (const control of [this.preview, this.placeholder]) {
                control.setAttribute("tabindex", "0");
                control.setAttribute("role", "button");
                control.setAttribute("aria-label", "Edit Typst formula");
            }
            const saved = this.querySelector("img");
            if (saved) {
                this.preview.src = saved.src;
                this.preview.style.cssText = saved.style.cssText;
                this.preview.hidden = false;
                this.placeholder.hidden = true;
            }
            this.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.open();
            });
            this.addEventListener("mousedown", (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                this.closest('[contenteditable="true"]')?.focus();
            });
            this.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    this.open();
                }
            });
            if (!saved || this.getAttribute("data-render") !== imageFormat ||
                saved.getAttribute("alt") !== `[typst]${this.source}[/typst]`) this.schedule();
        }

        disconnectedCallback() {
            clearTimeout(this.timer);
            if (active?.host === this) closeEditor(false, true);
        }

        schedule() {
            clearTimeout(this.timer);
            this.timer = setTimeout(() => this.compile(), 200);
        }

        compile() {
            clearTimeout(this.timer);
            if (!this.isConnected || this.running) return;
            const source = this.source;
            if (source.length > 50000) {
                this.status("This snippet exceeds 50,000 characters.", true);
                return;
            }
            const previous = this.querySelector("img")?.cloneNode(true);
            this.running = true;
            this.status("Compiling…");
            request(source, (result) => {
                this.running = false;
                if (!this.isConnected) return;
                // A slow result must never replace the preview for newer source.
                if (source !== this.source) {
                    this.compile();
                    return;
                }
                if (result.error) {
                    this.querySelector("img")?.remove();
                    if (previous) this.append(previous);
                    notify(this);
                    this.status(result.error, true);
                    this.setAttribute("title", "Typst error: " + result.error);
                    return;
                }
                this.preview.src = result.url;
                imageStyle(this.preview, result.width, result.height);
                this.preview.hidden = false;
                this.placeholder.hidden = true;
                let saved = this.querySelector("img");
                if (!saved) {
                    saved = document.createElement("img");
                    this.append(saved);
                }
                // Only a media filename is saved. The data URL lives in the shadow DOM.
                saved.setAttribute("src", result.filename);
                saved.setAttribute("alt", `[typst]${source}[/typst]`);
                this.setAttribute("data-render", imageFormat);
                imageStyle(saved, result.width, result.height);
                this.setAttribute("title", "Click to edit Typst");
                this.status("");
                notify(this);
            }, (acknowledgement) => {
                if (!this.isConnected || source !== this.source || !acknowledgement?.filename) return;
                // Save the reference immediately, so adding a card during compilation is safe.
                // Python writes that filename even if the editor moves on to another note.
                let saved = this.querySelector("img");
                if (!saved) {
                    saved = document.createElement("img");
                    this.append(saved);
                }
                saved.setAttribute("src", acknowledgement.filename);
                saved.setAttribute("alt", `[typst]${source}[/typst]`);
                notify(this);
            });
        }

        status(message, error = false) {
            if (active?.host !== this) return;
            active.status.textContent = message;
            active.status.style.color = error ? "#c23b32" : "inherit";
            positionEditor();
        }

        open() {
            if (active?.host === this) return;
            closeEditor(false);
            const field = this.closest('[contenteditable="true"]');
            field?.focus();
            const release = inputAPIs.get(field)?.preventResubscription();
            const panel = document.createElement("div");
            panel.id = "inline-typst-editor";
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-label", "Typst source");
            panel.style.cssText = "position:fixed;z-index:2147483647;box-sizing:border-box;" +
                "width:420px;max-width:calc(100vw - 16px);padding:10px;border:1px solid GrayText;" +
                "border-radius:5px;background:Canvas;color:CanvasText;color-scheme:light dark;" +
                "box-shadow:0 3px 12px #0003;font:13px system-ui;";
            const header = document.createElement("div");
            header.textContent = "Typst";
            header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px";
            const close = document.createElement("button");
            close.textContent = "×";
            close.setAttribute("aria-label", "Close Typst editor");
            close.addEventListener("click", () => closeEditor(true));
            header.append(close);
            const input = document.createElement("textarea");
            input.setAttribute("aria-label", "Typst source");
            input.spellcheck = false;
            input.rows = 3;
            input.value = this.source;
            input.style.cssText = "box-sizing:border-box;width:100%;resize:vertical;padding:6px;" +
                "font:14px/1.4 ui-monospace,monospace;background:Field;color:FieldText;caret-color:auto;";
            const status = document.createElement("div");
            status.setAttribute("role", "status");
            status.setAttribute("aria-live", "polite");
            status.style.cssText = "white-space:pre-wrap;max-height:140px;overflow:auto;margin-top:5px";
            panel.append(header, input, status);
            document.body.append(panel);
            active = { host: this, panel, input, status, release };
            input.addEventListener("input", () => {
                if (input.composing || active?.vim) return;
                this.source = input.value;
                this.setAttribute("data-source", this.source);
                notify(this);
                this.schedule();
            });
            input.addEventListener("compositionstart", () => { input.composing = true; });
            input.addEventListener("compositionend", (event) => {
                input.composing = false;
                if (active?.vim) {
                    if (event.data) enqueueVim(active.vim, { paste: event.data });
                } else input.dispatchEvent(new Event("input"));
            });
            input.addEventListener("beforeinput", (event) => {
                if (input.composing || event.isComposing || active?.vim) return;
                pairDollars(input, event);
            });
            input.addEventListener("paste", (event) => {
                if (!active?.vim) return;
                event.preventDefault();
                enqueueVim(active.vim, { paste: event.clipboardData.getData("text/plain") });
            });
            input.addEventListener("mouseup", () => {
                if (active?.vim && input.selectionStart === input.selectionEnd) {
                    enqueueVim(active.vim, { cursor: textPosition(input.value, input.selectionStart) });
                }
            });
            input.addEventListener("keydown", (event) => {
                if (event.isComposing) return;
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    closeEditor(true);
                    return;
                }
                if (active?.vim) {
                    const key = vimKey(event);
                    if (key) {
                        event.preventDefault();
                        event.stopPropagation();
                        enqueueVim(active.vim, { keys: key });
                    }
                    return;
                }
                if (event.key === "Escape" || event.key === "Tab" ||
                    (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
                    event.preventDefault();
                    closeEditor(true);
                }
            });
            positionEditor();
            input.focus();
            const end = this.source.endsWith("$") ? this.source.length - 1 : this.source.length;
            input.setSelectionRange(end, end);
            if (this.getAttribute("title")?.startsWith("Typst error: ")) {
                this.status(this.getAttribute("title").slice(13), true);
            }
            if (window.inlineTypstConfig?.vimEnabled) {
                const state = { session: ++vimSession, host: this, input, header,
                    ready: false, busy: true, pending: 1, queue: [], lastResult: 0 };
                active.vim = state;
                state.startTimer = setTimeout(() => receiveVim(state.session, {
                    error: "Neovim did not start. Check nvim_path and your Neovim config, then reopen the formula.",
                }), 5000);
                header.firstChild.textContent = "Typst · starting Vim…";
                pycmd("inline-typst-vim:" + JSON.stringify({ action: "start", session: state.session,
                    source: this.source, cursor: textPosition(this.source, end) }));
            }
        }
    }
    customElements.define(tag, Typst);

    function pairDollars(input, event) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const value = input.value;
        let replacement;
        let next = start;
        if (event.inputType === "insertText" && event.data === "$") {
            let slashes = 0;
            for (let i = start - 1; i >= 0 && value[i] === "\\"; i--) slashes++;
            if (slashes % 2) return;
            if (start === end && value[start] === "$") {
                event.preventDefault();
                input.setSelectionRange(start + 1, start + 1);
                return;
            }
            replacement = "$" + value.slice(start, end) + "$";
            next = start + replacement.length - 1;
        } else if (event.inputType === "deleteContentBackward" && start === end &&
            value.slice(start - 1, start + 1) === "$$") {
            event.preventDefault();
            input.value = value.slice(0, start - 1) + value.slice(start + 1);
            input.setSelectionRange(start - 1, start - 1);
            input.dispatchEvent(new Event("input"));
            return;
        } else return;
        event.preventDefault();
        input.value = value.slice(0, start) + replacement + value.slice(end);
        input.setSelectionRange(next, next);
        input.dispatchEvent(new Event("input"));
    }

    function textPosition(source, offset) {
        const lines = source.slice(0, offset).split("\n");
        return [lines.length, new TextEncoder().encode(lines[lines.length - 1]).length];
    }

    function vimKey(event) {
        if (["Shift", "Control", "Alt", "Meta", "Dead", "Process"].includes(event.key)) return null;
        if (event.metaKey && ["c", "v"].includes(event.key.toLowerCase())) return null;
        const names = { Escape: "Esc", Enter: "CR", Backspace: "BS", Delete: "Del",
            ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down",
            Tab: "Tab", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
        if (!event.ctrlKey && !event.altKey && !event.metaKey && !names[event.key]) {
            return event.key === "<" ? "<LT>" : (Array.from(event.key).length === 1 ? event.key : null);
        }
        const modifiers = (event.ctrlKey ? "C-" : "") + (event.altKey ? "M-" : "") +
            (event.metaKey ? "D-" : "") + (event.shiftKey && names[event.key] ? "S-" : "");
        return `<${modifiers}${names[event.key] || event.key}>`;
    }

    function enqueueVim(state, command) {
        const last = state.queue[state.queue.length - 1];
        if (last?.keys && command.keys) last.keys += command.keys;
        else state.queue.push(command);
        pumpVim(state);
    }

    function pumpVim(state) {
        if (!state.ready) return;
        // Do not wait for a response before sending another key: Vim may be
        // waiting for the second key of a mapping such as the user's `jk`.
        while (state.queue.length) {
            state.pending++;
            state.busy = true;
            pycmd("inline-typst-vim:" + JSON.stringify({ action: "keys", session: state.session, ...state.queue.shift() }));
        }
    }

    function receiveVim(session, result) {
        const state = active?.vim;
        if (!state || state.session !== session) return;
        if (result.id === 0 && (state.busy || state.queue.length)) return;
        clearTimeout(state.startTimer);
        if (result.error) {
            active.vim = null;
            state.header.firstChild.textContent = "Typst · Vim unavailable";
            state.host.status(result.error, true);
            pycmd("inline-typst-vim:" + JSON.stringify({ action: "stop", session }));
            return;
        }
        state.ready = true;
        if (result.id !== 0) {
            state.pending = Math.max(0, state.pending - 1);
            state.busy = state.pending > 0;
            if (result.id < state.lastResult) return;
            state.lastResult = result.id;
        }
        if (state.host.source !== result.source) {
            state.host.source = result.source;
            state.host.setAttribute("data-source", result.source);
            notify(state.host);
            state.host.schedule();
        }
        state.input.value = result.source;
        const visual = result.mode === "v" || result.mode === "V" || result.mode === "\x16";
        const insert = result.mode.startsWith("i") || result.mode.startsWith("R");
        const start = visual ? Math.min(result.offset, result.anchor) : result.offset;
        let end = visual ? Math.max(result.offset, result.anchor) : result.offset;
        if (!insert && result.source[end] && result.source[end] !== "\n") {
            end += result.source.codePointAt(end) > 0xffff ? 2 : 1;
        }
        state.input.setSelectionRange(start, end, visual && result.offset < result.anchor ? "backward" : "forward");
        const mode = insert ? "INSERT" : visual ? "VISUAL" : result.mode.startsWith("c") ? ":" + result.command : "NORMAL";
        state.header.firstChild.textContent = "Typst · " + mode;
        pumpVim(state);
        if (!state.busy && !state.queue.length && state.closeWhenIdle !== undefined) {
            closeEditor(state.closeWhenIdle);
        }
    }

    function positionEditor() {
        if (!active) return;
        const rect = active.host.getBoundingClientRect();
        const panel = active.panel;
        panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - panel.offsetWidth - 8)) + "px";
        panel.style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - panel.offsetHeight - 8)) + "px";
    }

    function closeEditor(focus, force = false) {
        if (!active) return;
        if (!force && active.vim && (active.vim.busy || active.vim.queue.length)) {
            active.vim.closeWhenIdle = focus;
            return;
        }
        const { host, panel, release, vim } = active;
        if (vim) {
            clearTimeout(vim.startTimer);
            pycmd("inline-typst-vim:" + JSON.stringify({ action: "stop", session: vim.session }));
        }
        active = null;
        panel.remove();
        if (!host.isConnected) {
            release?.();
            return;
        }
        if (host.source !== host.querySelector("img")?.getAttribute("alt")?.slice(7, -8)) {
            host.compile();
        }
        if (focus) {
            const field = host.closest('[contenteditable="true"]');
            field?.focus();
            const range = document.createRange();
            range.setStartAfter(host);
            range.collapse(true);
            const selection = host.getRootNode().getSelection?.() || window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        release?.();
    }

    function atom(source) {
        const host = document.createElement(tag);
        host.setAttribute("data-source", source);
        return host;
    }

    function scanField(field, openNew) {
        // Upgrade images made by version 1 without recompiling or changing their source.
        for (const image of field.querySelectorAll('img[alt^="[typst]"]')) {
            if (image.closest(tag)) continue;
            const match = /^\[typst\]([\s\S]*)\[\/typst\]$/.exec(image.getAttribute("alt"));
            const filename = image.getAttribute("src") || "";
            if (!match || !/(?:^|\/)typst-[^/]+\.png$/.test(filename)) continue;
            const host = atom(match[1]);
            image.replaceWith(host);
            host.append(image);
            // connectedCallback ran before the old image was moved into the host.
            host.preview.src = image.src;
            host.preview.style.cssText = image.style.cssText;
            host.preview.hidden = false;
            host.placeholder.hidden = true;
            host.schedule();
            notify(host);
        }
        const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.parentElement.closest(`${tag}, anki-mathjax, [contenteditable="false"]`)) nodes.push(node);
        }
        let latest;
        for (const node of nodes) {
            const matches = [...node.data.matchAll(/\[typst\]([\s\S]*?)\[\/typst\]/g)];
            if (!matches.length) continue;
            const fragment = document.createDocumentFragment();
            let end = 0;
            for (const match of matches) {
                fragment.append(document.createTextNode(node.data.slice(end, match.index)));
                latest = atom(match[1]);
                fragment.append(latest);
                end = match.index + match[0].length;
            }
            fragment.append(document.createTextNode(node.data.slice(end)));
            node.replaceWith(fragment);
            notify(latest);
        }
        if (latest && openNew) latest.open();
    }

    function scan(openNew = false) {
        for (const field of fields) {
            if (!field.isConnected) {
                fields.delete(field);
                continue;
            }
            scanField(field, openNew);
        }
    }

    function discover(root) {
        if (roots.has(root)) return;
        roots.add(root);
        function visit(element) {
            if (element.matches?.('anki-editable[contenteditable="true"], .field[contenteditable="true"]')) {
                fields.add(element);
                element.addEventListener("input", () => {
                    clearTimeout(scanTimer);
                    scanTimer = setTimeout(() => scanField(element, false), 30);
                });
            }
            if (element.shadowRoot && element.localName !== tag) discover(element.shadowRoot);
        }
        for (const element of root.querySelectorAll("*")) visit(element);
        new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    visit(node);
                    for (const element of node.querySelectorAll("*")) visit(element);
                }
            }
            clearTimeout(scanTimer);
            scanTimer = setTimeout(() => scan(), 30);
        }).observe(root, { childList: true, subtree: true });
    }

    window.inlineTypst = {
        scan,
        vimReceive: receiveVim,
        receive(id, result) {
            const callback = pending.get(id);
            pending.delete(id);
            callback?.(result);
        },
    };
    document.addEventListener("pointerdown", (event) => {
        if (active && !event.composedPath().includes(active.panel) &&
            !event.composedPath().includes(active.host)) closeEditor(false);
    }, true);
    window.addEventListener("resize", positionEditor);
    document.addEventListener("scroll", positionEditor, true);
    discover(document);
    scan();
})();
