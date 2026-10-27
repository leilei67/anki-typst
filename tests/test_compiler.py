import shutil
import unittest

from anki_typst.compiler import CompileError, compile_snippet, find_compiler


class CompilerTests(unittest.TestCase):
    def test_missing_compiler_is_actionable(self):
        with self.assertRaisesRegex(CompileError, "compiler_path"):
            find_compiler("/nonexistent/typst")

    @unittest.skipUnless(shutil.which("typst"), "Typst CLI required")
    def test_real_compilation_and_stable_name(self):
        name, data = compile_snippet("$x^2 + y^2 = z^2$")
        self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(name, compile_snippet("$x^2 + y^2 = z^2$")[0])
        self.assertNotEqual(name, compile_snippet("$x^3$")[0])

    @unittest.skipUnless(shutil.which("typst"), "Typst CLI required")
    def test_invalid_source_reports_error(self):
        with self.assertRaises(CompileError):
            compile_snippet("#this_function_does_not_exist()")

    @unittest.skipUnless(shutil.which("typst"), "Typst CLI required")
    def test_files_outside_temporary_root_are_inaccessible(self):
        with self.assertRaises(CompileError):
            compile_snippet('#read("/etc/passwd")')
