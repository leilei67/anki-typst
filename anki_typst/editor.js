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
                'background:white}span{font:inherit;opacity:.6}:host(:focus){outline:1px solid Highlight}' +
                '</style><img hidden><span>Typst…</span>';
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
            if (!saved || saved.getAttribute("alt") !== `[typst]${this.source}[/typst]`) this.schedule();
        }

        disconnectedCallback() {
            clearTimeout(this.timer);
            if (active?.host === this) closeEditor(false);
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
                "font:14px/1.4 ui-monospace,monospace;background:Field;color:FieldText;";
            const status = document.createElement("div");
            status.setAttribute("role", "status");
            status.setAttribute("aria-live", "polite");
            status.style.cssText = "white-space:pre-wrap;max-height:140px;overflow:auto;margin-top:5px";
            panel.append(header, input, status);
            document.body.append(panel);
            active = { host: this, panel, input, status, release };
            input.addEventListener("input", () => {
                if (input.composing) return;
                this.source = input.value;
                this.setAttribute("data-source", this.source);
                notify(this);
                this.schedule();
            });
            input.addEventListener("compositionstart", () => { input.composing = true; });
            input.addEventListener("compositionend", () => {
                input.composing = false;
                input.dispatchEvent(new Event("input"));
            });
            input.addEventListener("keydown", (event) => {
                if (event.isComposing) return;
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
        }
    }
    customElements.define(tag, Typst);

    function positionEditor() {
        if (!active) return;
        const rect = active.host.getBoundingClientRect();
        const panel = active.panel;
        panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - panel.offsetWidth - 8)) + "px";
        panel.style.top = Math.max(8, Math.min(rect.bottom + 5, innerHeight - panel.offsetHeight - 8)) + "px";
    }

    function closeEditor(focus) {
        if (!active) return;
        const { host, panel, release } = active;
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
            clearTimeout(host.timer);
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
