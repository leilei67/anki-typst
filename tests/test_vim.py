import queue
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from anki_typst.vim import Neovim, cursor_offset, find_neovim


class VimUtilityTests(unittest.TestCase):
    def test_unicode_cursor_uses_browser_utf16_offsets(self):
        self.assertEqual(cursor_offset('α😀\nxyz', [1, 6]), 3)
        self.assertEqual(cursor_offset('α😀\nxyz', [2, 2]), 6)

    def test_missing_executable_is_actionable(self):
        with self.assertRaisesRegex(RuntimeError, 'nvim_path'):
            find_neovim('/nonexistent/nvim')


@unittest.skipUnless(shutil.which('nvim'), 'Neovim required')
class NeovimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = Path(self.tmp.name) / 'init.vim'
        config.write_text('inoremap jk <Esc>\nnnoremap dd "_dd\nnnoremap d "_d\n')
        self.config = {'vimrc_path': str(config)}
        self.engine = Neovim(self.config, lambda _: None)

    def tearDown(self):
        self.engine.close()
        self.tmp.cleanup()

    def test_config_mapping_changes_mode_and_preserves_source(self):
        self.engine.send(source='$x$', cursor=[1, 2])
        result = self.engine.send(keys='jk')
        self.assertEqual(result['mode'], 'n')
        self.assertEqual(result['source'], '$x$')

    def test_black_hole_delete_mapping_preserves_yanked_text(self):
        self.engine.send(source='keep\nremove\nlast', cursor=[1, 0])
        self.engine.send(keys='<Esc>yyjdd')
        result = self.engine.send(keys='p')
        self.assertEqual(result['source'], 'keep\nlast\nkeep')

    def test_dollar_pairing_skip_and_backspace(self):
        self.engine.send(source='', cursor=[1, 0])
        result = self.engine.send(keys='$')
        self.assertEqual((result['source'], result['offset']), ('$$', 1))
        result = self.engine.send(keys='$')
        self.assertEqual(result['source'], '$$')
        self.assertEqual(result['offset'], 2)
        self.engine.send(cursor=[1, 1])
        self.assertEqual(self.engine.send(keys='<BS>')['source'], '')

    def test_paste_does_not_execute_vim_mappings(self):
        self.engine.send(source='', cursor=[1, 0])
        result = self.engine.send(paste='jk $x$')
        self.assertEqual(result['source'], 'jk $x$')
        self.assertTrue(result['mode'].startswith('i'))

    def test_separate_keystrokes_complete_a_mapping_without_waiting_for_responses(self):
        updates = queue.Queue()
        engine = Neovim(self.config, updates.put, streaming=True)
        try:
            engine.write(source='$x$', cursor=[1, 2])
            updates.get(timeout=3)
            engine.write(keys='j')
            time.sleep(0.025)
            engine.write(keys='k')
            result = updates.get(timeout=3)
            self.assertEqual(result['mode'], 'n')
            self.assertEqual(result['source'], '$x$')
        finally:
            engine.close()

    def test_process_ends_when_popup_closes(self):
        self.engine.send(source='$x$', cursor=[1, 2])
        self.engine.close()
        self.assertIsNotNone(self.engine.process.poll())
