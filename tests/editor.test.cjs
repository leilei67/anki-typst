const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseHTML } = require('linkedom');
const code = fs.readFileSync('anki_typst/editor.js', 'utf8');

function fixture(html, options = {}) {
    delete global.inlineTypst;
    delete global.inlineTypstConfig;
    const { window, document } = parseHTML('<html><body><div id="editor"></div></body></html>');
    window.inlineTypstConfig = options;
    const shadow = document.querySelector('#editor').attachShadow({ mode: 'open' });
    shadow.innerHTML = `<anki-editable contenteditable="true">${html}</anki-editable>`;
    const field = shadow.querySelector('anki-editable');
    const requests = [];
    const vimRequests = [];
    const acknowledgements = new Map();
    let guarded = false;
    const timers = new Map();
    let nextTimer = 0;
    // linkedom has no layout or text selection. These stubs only support opening the source popup.
    window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 10, bottom: 30 });
    window.HTMLElement.prototype.setSelectionRange = function (start, end) { this.selectionStart = start; this.selectionEnd = end; };
    const context = {
        window, document, HTMLElement: window.HTMLElement, customElements: window.customElements,
        MutationObserver: window.MutationObserver, Event: window.Event, Node: window.Node,
        InputEvent: window.Event,
        TextEncoder,
        NodeFilter: { SHOW_TEXT: 4 }, innerWidth: 1024, innerHeight: 768,
        require(name) {
            assert.equal(name, 'anki/RichTextInput');
            return {
                instances: [{ element: Promise.resolve(field), preventResubscription() {
                    guarded = true;
                    return () => { guarded = false; };
                } }],
                lifecycle: { onMount() {} },
            };
        },
        setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        pycmd(message, acknowledge) {
            if (message.startsWith('inline-typst-vim:')) {
                vimRequests.push(JSON.parse(message.slice('inline-typst-vim:'.length)));
                return;
            }
            const request = JSON.parse(message.slice('inline-typst:'.length));
            requests.push(request);
            acknowledgements.set(request.id, acknowledge);
        },
    };
    vm.runInNewContext(code, context);
    // Browsers upgrade elements in existing shadow trees when define() runs; linkedom needs this explicitly.
    for (const host of field.querySelectorAll('anki-typst')) window.customElements.upgrade(host);
    return {
        window, document, field, requests, vimRequests,
        get guarded() { return guarded; },
        acknowledge(request, filename) { acknowledgements.get(request.id)({ filename }); },
        async flush(maxDelay = 1000) {
            await new Promise(setImmediate);
            for (const [id, timer] of [...timers]) {
                if (timer.delay <= maxDelay) {
                    timers.delete(id);
                    timer.fn();
                }
            }
            await new Promise(setImmediate);
        },
        respond(request, extra = {}) {
            window.inlineTypst.receive(request.id, {
                filename: 'typst-test.png', url: 'data:image/png;base64,preview',
                width: 40, height: 20, ...extra,
            });
        },
    };
}

test('inline source renders inside Anki shadow fields and stores a media reference', async () => {
    const f = fixture('Before [typst]$x^2$[/typst] after');
    const host = f.field.querySelector('anki-typst');
    assert.equal(host.getAttribute('data-source'), '$x^2$');
    await f.flush();
    assert.equal(f.requests.length, 1);
    f.respond(f.requests[0]);
    assert.equal(host.shadowRoot.querySelector('img').src, 'data:image/png;base64,preview');
    assert.match(f.field.innerHTML, /src="typst-test.png"/);
    assert.doesNotMatch(f.field.innerHTML, /data:image/);
    assert.equal(f.field.firstChild.textContent, 'Before ');
    assert.equal(f.field.lastChild.textContent, ' after');
});

test('clicking a formula opens editable source; rapid typing compiles only the latest value', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.respond(f.requests[0]);
    const host = f.field.querySelector('anki-typst');
    host.dispatchEvent(new f.window.Event('click', { bubbles: true }));
    const input = f.document.querySelector('textarea');
    assert.equal(input.value, '$x$');
    for (const source of ['$x^2$', '$x^3$', '$x^4$']) {
        input.value = source;
        input.dispatchEvent(new f.window.Event('input'));
    }
    await f.flush();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].source, '$x^4$');
    assert.equal(host.getAttribute('data-source'), '$x^4$');
    f.respond(f.requests[1]);
    assert.equal(host.querySelector('img').getAttribute('alt'), '[typst]$x^4$[/typst]');
});

test('slow results cannot overwrite a newer formula', async () => {
    const f = fixture('[typst]$a$[/typst]');
    await f.flush();
    const host = f.field.querySelector('anki-typst');
    host.open();
    const input = f.document.querySelector('textarea');
    input.value = '$b$';
    input.dispatchEvent(new f.window.Event('input'));
    await f.flush();
    assert.equal(f.requests.length, 1, 'one compilation per formula at a time');
    f.respond(f.requests[0]);
    assert.equal(host.querySelector('img'), null, 'stale image was discarded');
    assert.equal(f.requests[1].source, '$b$');
    f.respond(f.requests[1]);
    assert.equal(host.querySelector('img').getAttribute('alt'), '[typst]$b$[/typst]');
});

test('compiler errors stay inline and preserve source and the last good image', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.respond(f.requests[0]);
    const host = f.field.querySelector('anki-typst');
    host.open();
    const input = f.document.querySelector('textarea');
    input.value = '#broken()';
    input.dispatchEvent(new f.window.Event('input'));
    await f.flush();
    f.respond(f.requests[1], { error: 'unknown function: broken' });
    assert.match(f.document.querySelector('[role="status"]').textContent, /unknown function/);
    assert.equal(host.getAttribute('data-source'), '#broken()');
    assert.equal(host.querySelector('img').getAttribute('alt'), '[typst]$x$[/typst]');
});

test('version 1 images become clickable formulas and refresh with a transparent background', async () => {
    const f = fixture('Before <img src="typst-old.png" alt="[typst]$x$[/typst]"> after');
    const host = f.field.querySelector('anki-typst');
    assert.equal(host.getAttribute('data-source'), '$x$');
    assert.equal(host.querySelector('img').getAttribute('src'), 'typst-old.png');
    await f.flush();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].source, '$x$');
});

test('reopening saved fields preserves source and does not recompile', async () => {
    const f = fixture('<anki-typst data-source="$x$" data-render="transparent-v1" contenteditable="false">' +
        '<img src="typst-saved.png" alt="[typst]$x$[/typst]"></anki-typst>');
    const host = f.field.querySelector('anki-typst');
    assert.equal(host.getAttribute('data-source'), '$x$');
    await f.flush();
    assert.equal(f.requests.length, 0);
    host.open();
    assert.equal(f.document.querySelector('textarea').value, '$x$');
});

test('partial tags and ordinary MathJax are left alone', async () => {
    const f = fixture('Before [typst]$x <anki-mathjax>y</anki-mathjax>');
    assert.equal(f.field.querySelector('anki-typst'), null);
    assert.equal(f.field.querySelector('anki-mathjax').textContent, 'y');
    await f.flush();
    assert.equal(f.requests.length, 0);
});

test('new notes are discovered after the editor replaces a field', async () => {
    const f = fixture('Original field');
    const shadow = f.field.getRootNode();
    const next = f.document.createElement('anki-editable');
    next.setAttribute('contenteditable', 'true');
    next.textContent = '[typst]$new$[/typst]';
    f.field.replaceWith(next);
    await f.flush();
    await f.flush();
    assert.equal(next.querySelector('anki-typst').getAttribute('data-source'), '$new$');
    assert.equal(f.requests[0].source, '$new$');
});

test('source popup uses Anki mirror guard and releases it when closed', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.respond(f.requests[0]);
    f.field.querySelector('anki-typst').open();
    assert.equal(f.guarded, true);
    f.document.dispatchEvent(new f.window.Event('pointerdown'));
    assert.equal(f.guarded, false);
    assert.equal(f.document.querySelector('textarea'), null);
});

test('media reference is saved before slow compilation finishes', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.acknowledge(f.requests[0], 'typst-pending.png');
    assert.equal(f.field.querySelector('img').getAttribute('src'), 'typst-pending.png');
    assert.doesNotMatch(f.field.innerHTML, /data:image/);
    f.respond(f.requests[0], { filename: 'typst-pending.png' });
    assert.equal(f.field.querySelector('img').getAttribute('src'), 'typst-pending.png');
});

test('a failed compilation restores the last good saved image after an acknowledgement', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.respond(f.requests[0]);
    const host = f.field.querySelector('anki-typst');
    host.open();
    const input = f.document.querySelector('textarea');
    input.value = '#bad()';
    input.dispatchEvent(new f.window.Event('input'));
    await f.flush();
    f.acknowledge(f.requests[1], 'typst-failed.png');
    f.respond(f.requests[1], { error: 'compilation failed' });
    assert.equal(host.querySelector('img').getAttribute('src'), 'typst-test.png');
    assert.equal(host.getAttribute('data-source'), '#bad()');
});

function key(input, window, name, extra = {}) {
    const event = new window.Event('keydown', { bubbles: true, cancelable: true });
    Object.assign(event, { key: name, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...extra });
    input.dispatchEvent(event);
    return event;
}

function beforeInput(input, window, inputType, data) {
    const event = new window.Event('beforeinput', { bubbles: true, cancelable: true });
    Object.assign(event, { inputType, data });
    input.dispatchEvent(event);
    return event;
}

test('transparent formulas include theme rules for both the popup preview and saved cards', async () => {
    const f = fixture('[typst]$x$[/typst]');
    await f.flush();
    f.respond(f.requests[0]);
    const host = f.field.querySelector('anki-typst');
    assert.match(host.shadowRoot.querySelector('style').textContent, /background:transparent/);
    assert.match(host.shadowRoot.querySelector('style').textContent, /host-context\(\.nightMode\)/);
    assert.match(host.querySelector('style[data-typst-theme]').textContent, /filter:invert\(1\)/);
    assert.equal(host.getAttribute('data-render'), 'transparent-v1');
    assert.ok(host.querySelector('img').classList.contains('typst-transparent'));
});

test('typing a dollar pairs it, skips its closing partner, and backspaces the empty pair', async () => {
    const f = fixture('[typst][/typst]');
    await f.flush();
    f.field.querySelector('anki-typst').open();
    const input = f.document.querySelector('textarea');
    beforeInput(input, f.window, 'insertText', '$');
    assert.equal(input.value, '$$');
    assert.equal(input.selectionStart, 1);
    beforeInput(input, f.window, 'insertText', '$');
    assert.equal(input.value, '$$');
    assert.equal(input.selectionStart, 2);
    input.setSelectionRange(1, 1);
    beforeInput(input, f.window, 'deleteContentBackward', null);
    assert.equal(input.value, '');
});

test('dollar pairing wraps a selection and leaves escaped dollars alone', async () => {
    const f = fixture('[typst]alpha[/typst]');
    await f.flush();
    f.field.querySelector('anki-typst').open();
    const input = f.document.querySelector('textarea');
    input.setSelectionRange(0, 5);
    beforeInput(input, f.window, 'insertText', '$');
    assert.equal(input.value, '$alpha$');
    input.value = '\\';
    input.setSelectionRange(1, 1);
    assert.equal(beforeInput(input, f.window, 'insertText', '$').defaultPrevented, false);
});

test('Vim starts at the source cursor and Escape goes to Neovim rather than closing the popup', async () => {
    const f = fixture('[typst]$x$[/typst]', { vimEnabled: true });
    await f.flush();
    f.field.querySelector('anki-typst').open();
    const start = f.vimRequests[0];
    assert.equal(start.action, 'start');
    assert.deepEqual(start.cursor, [1, 2]);
    f.window.inlineTypst.vimReceive(start.session, { id: 1, source: '$x$', offset: 2, anchor: 2, mode: 'i', command: '' });
    const input = f.document.querySelector('textarea');
    const event = key(input, f.window, 'Escape');
    assert.equal(event.defaultPrevented, true);
    assert.equal(f.vimRequests[1].keys, '<Esc>');
    assert.ok(f.document.querySelector('textarea'));
    f.window.inlineTypst.vimReceive(start.session, { id: 2, source: '$x$', offset: 1, anchor: 1, mode: 'n', command: '' });
    assert.match(f.document.querySelector('#inline-typst-editor').textContent, /NORMAL/);
});

test('Vim forwards the second mapping key before the first key has a response', async () => {
    const f = fixture('[typst]$x$[/typst]', { vimEnabled: true });
    await f.flush();
    f.field.querySelector('anki-typst').open();
    const session = f.vimRequests[0].session;
    f.window.inlineTypst.vimReceive(session, { id: 1, source: '$x$', offset: 2, anchor: 2, mode: 'i', command: '' });
    const input = f.document.querySelector('textarea');
    key(input, f.window, 'j');
    key(input, f.window, 'k');
    assert.deepEqual(f.vimRequests.slice(1).map((request) => request.keys), ['j', 'k']);
    f.window.inlineTypst.vimReceive(session, { id: 2, source: '$x$', offset: 1, anchor: 1, mode: 'n', command: '' });
    f.window.inlineTypst.vimReceive(session, { id: 3, source: '$x$', offset: 1, anchor: 1, mode: 'n', command: '' });
    assert.equal(input.value, '$x$');
    assert.match(f.document.querySelector('#inline-typst-editor').textContent, /NORMAL/);
});

test('a missing Vim engine keeps the plain source editor usable', async () => {
    const f = fixture('[typst]$x$[/typst]', { vimEnabled: true });
    await f.flush();
    f.field.querySelector('anki-typst').open();
    const session = f.vimRequests[0].session;
    f.window.inlineTypst.vimReceive(session, { error: 'Neovim was not found' });
    const input = f.document.querySelector('textarea');
    assert.match(f.document.querySelector('[role="status"]').textContent, /Neovim was not found/);
    input.value = '$y$';
    input.dispatchEvent(new f.window.Event('input'));
    assert.equal(f.field.querySelector('anki-typst').getAttribute('data-source'), '$y$');
    assert.equal(f.vimRequests[1].action, 'stop');
});
