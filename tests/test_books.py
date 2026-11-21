import codecs
import unittest

from taleside.books import BookSource, prepare_book


class TextTests(unittest.TestCase):
    def test_prefers_paragraph_line_punctuation_space_then_exact_limit(self):
        cases = [
            ("aaaaaaa\n\n. continued", 9),
            ("aaaaaaaa\n. continued", 9),
            ("aaaaaaaa. continued", 9),
            ("aaaaaaaa bcontinued", 9),
            ("aaaaaaaaaaaaaaa", 10),
        ]
        for text, first_end in cases:
            with self.subTest(text=text):
                working, _, _, chunks = prepare_book(BookSource("book.txt", text.encode()), 10)
                self.assertEqual(chunks[0].end, first_end)
                self.assertEqual("".join(working[chunk.start:chunk.end] for chunk in chunks), text)

    def test_source_offsets_include_original_line_endings_and_multibyte_characters(self):
        text = "A\r\n😀é\rZ"
        for encoding, bom, expected in [
            ("utf-8", codecs.BOM_UTF8, [(3, 6), (6, 12), (12, 14)]),
            ("utf-16-le", codecs.BOM_UTF16_LE, [(2, 8), (8, 14), (14, 18)]),
            ("utf-16-be", codecs.BOM_UTF16_BE, [(2, 8), (8, 14), (14, 18)]),
        ]:
            with self.subTest(encoding=encoding):
                working, _, _, chunks = prepare_book(BookSource("book.txt", bom + text.encode(encoding)), 2)
                self.assertEqual(working, "A\n😀é\nZ")
                self.assertEqual([(chunk.original_start, chunk.original_end) for chunk in chunks], expected)

    def test_paragraph_with_indentation_ending_inside_the_search_window(self):
        text = "aaaaaaa\n   \n. continued"
        _, _, _, chunks = prepare_book(BookSource("book.txt", text.encode()), 13)
        self.assertEqual(chunks[0].end, 12)
        _, _, _, chunks = prepare_book(BookSource("book.txt", text.encode()), 14)
        self.assertEqual(chunks[0].end, 13)

    def test_rejects_empty_invalid_and_non_txt_books(self):
        for source in [BookSource("empty.txt", b" \n"), BookSource("invalid.txt", b"\xff"),
                       BookSource("book.epub", b"Some text")]:
            with self.subTest(source=source.filename), self.assertRaises(ValueError):
                prepare_book(source, 8)
