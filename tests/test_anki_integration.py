"""Optional checks against an installed Anki's actual Python libraries."""
import importlib.util
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


@unittest.skipUnless(importlib.util.find_spec('aqt'), 'Anki Python libraries required')
class AnkiIntegrationTests(unittest.TestCase):
    def setUp(self):
        import aqt
        import anki_typst
        from anki.collection import Collection
        from aqt import gui_hooks
        from aqt.editor import NewEditor

        self.tmp = tempfile.TemporaryDirectory()
        self.collection = Collection(str(Path(self.tmp.name) / 'test.anki2'))
        self.jobs = []
        self.callbacks = []
        self.editor = object.__new__(NewEditor)
        self.editor.web = SimpleNamespace(eval=self.callbacks.append)
        self.mw = SimpleNamespace(
            col=self.collection,
            addonManager=SimpleNamespace(getConfig=lambda _: {}),
            taskman=SimpleNamespace(run_in_background=self.enqueue),
        )
        self.patch = patch.object(aqt, 'mw', self.mw)
        self.patch.start()
        self.hooks = [gui_hooks.editor_did_init, gui_hooks.editor_did_load_note,
                      gui_hooks.editor_did_init_buttons, gui_hooks.webview_did_receive_js_message]
        before = [len(hook._hooks) for hook in self.hooks]
        anki_typst.register()
        self.added_hooks = [hook._hooks[count:] for hook, count in zip(self.hooks, before)]
        self.handler = self.added_hooks[-1][0]

    def tearDown(self):
        for hook, functions in zip(self.hooks, self.added_hooks):
            for function in functions:
                hook.remove(function)
        self.patch.stop()
        self.collection.close()
        self.tmp.cleanup()

    def enqueue(self, task, done, uses_collection):
        self.assertFalse(uses_collection, 'compilation must not lock the collection')
        self.jobs.append((task, done))

    def finish(self):
        task, done = self.jobs.pop(0)
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(task)
        done(future)

    def request(self, source):
        return self.handler((False, None), 'inline-typst:' + json.dumps({'id': 1, 'source': source}), self.editor)

    def result(self):
        js = self.callbacks[-1]
        return json.loads('[' + js[len('window.inlineTypst?.receive('):-2] + ']')[1]

    def test_background_render_and_saved_media_survive_note_reload(self):
        handled, ack = self.request('$x^2$')
        self.assertTrue(handled)
        self.assertEqual(self.callbacks, [], 'compilation is asynchronous')
        model = self.collection.models.by_name('Basic')
        note = self.collection.new_note(model)
        note.fields[0] = '<anki-typst data-source="$x^2$" contenteditable="false">' + \
            f'<img src="{ack["filename"]}" alt="[typst]$x^2$[/typst]"></anki-typst>'
        self.collection.add_note(note, self.collection.decks.id('Default'))
        self.finish()
        result = self.result()
        self.assertEqual(result['filename'], ack['filename'])
        self.assertTrue((Path(self.collection.media.dir()) / result['filename']).is_file())
        loaded = self.collection.get_note(note.id)
        self.assertIn('data-source="$x^2$"', loaded.fields[0])
        self.assertEqual(self.collection.media.files_in_str(model['id'], loaded.fields[0]), [result['filename']])

    def test_compilation_errors_are_returned_to_the_popup(self):
        self.request('#unknown_typst_function()')
        self.finish()
        self.assertIn('error', self.result())

    def test_closing_the_profile_discards_pending_results(self):
        self.request('$x$')
        self.mw.col = None
        self.finish()
        self.assertEqual(self.callbacks, [])
        self.assertEqual(list(Path(self.collection.media.dir()).glob('typst-*.png')), [])

    def test_media_is_written_even_if_editor_closes_before_compilation_finishes(self):
        _, ack = self.request('$x$')
        self.editor.web = None
        self.finish()
        self.assertTrue((Path(self.collection.media.dir()) / ack['filename']).is_file())
        self.assertEqual(self.callbacks, [])

    def test_other_bridge_messages_and_invalid_requests_are_not_compiled(self):
        handled = (True, 'other handler result')
        self.assertEqual(self.handler(handled, 'unrelated', self.editor), handled)
        self.assertEqual(self.handler((False, None), 'inline-typst:bad json', self.editor), (True, None))
        self.assertEqual(self.jobs, [])
