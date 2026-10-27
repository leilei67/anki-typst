import base64
import json
import shutil
import unittest

from anki_typst.compiler import snippet_name
from anki_typst.live import compile_preview, parse_request


class LiveTests(unittest.TestCase):
    def test_valid_bridge_request(self):
        request = {"id": 1, "source": '$x < y$\n#text("quoted")'}
        self.assertEqual(parse_request(json.dumps(request)), request)

    def test_rejects_invalid_bridge_requests(self):
        for request in [None, [], {}, {"id": True, "source": "x"},
                        {"id": 0, "source": "x"}, {"id": 2**53, "source": "x"},
                        {"id": 1, "source": 5}, {"id": 1, "source": "x" * 50001}]:
            with self.subTest(request=str(request)[:60]):
                with self.assertRaises(ValueError):
                    parse_request(json.dumps(request))

    @unittest.skipUnless(shutil.which("typst"), "Typst CLI required")
    def test_preview_bytes_dimensions_and_predicted_media_name(self):
        preview = compile_preview("$frac(a, b)$")
        self.assertEqual(preview["name"], snippet_name("$frac(a, b)$"))
        self.assertEqual(base64.b64decode(preview["url"].split(",", 1)[1]), preview["png"])
        self.assertGreater(preview["width"], 0)
        self.assertGreater(preview["height"], 0)
