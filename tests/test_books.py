import codecs
import io
import unittest
import zipfile

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

    def test_rejects_empty_invalid_and_unreadable_books(self):
        for source in [BookSource("empty.txt", b" \n"), BookSource("invalid.txt", b"\xff"),
                       BookSource("book.epub", b"Some text")]:
            with self.subTest(source=source.filename), self.assertRaises(ValueError):
                prepare_book(source, 8)

    def test_epub_uses_spine_order_and_keeps_visible_sections(self):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book/p.opf"/></rootfiles></container>')
            archive.writestr("book/p.opf", '''<package><manifest>
                <item id="lore" href="lore.xhtml" media-type="application/xhtml+xml"/>
                <item id="opening" href="Opening%20Page.xhtml" media-type="application/xhtml+xml"/>
                <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
                <item id="extra" href="extra.xhtml" media-type="application/xhtml+xml"/>
              </manifest><spine><itemref idref="nav"/><itemref idref="opening"/>
                <itemref idref="extra" linear="no"/><itemref idref="lore"/>
              </spine></package>''')
            archive.writestr("book/lore.xhtml", "<h2>Lore</h2><p>The old road.</p>")
            archive.writestr("book/Opening Page.xhtml", "<h1>Prologue</h1><p>Start &amp; go.</p><p hidden>Hidden</p>")
            archive.writestr("book/nav.xhtml", "<ol><li>Table of Contents</li></ol>")
            archive.writestr("book/extra.xhtml", "<p>Not in the primary reading order</p>")
            archive.writestr("book/unused.xhtml", "<p>Unused file</p>")
        working, encoding, _, _ = prepare_book(BookSource("book.epub", output.getvalue()), 10)
        self.assertEqual(encoding, "extracted")
        self.assertEqual(working, "Prologue\n\nStart & go.\n\nLore\n\nThe old road.")

    def test_html_extracts_paragraphs_and_markdown_retains_source(self):
        html = b"<head><title>Metadata</title></head><p>A <em>real</em> paragraph.</p><p>Another.<br>Line.</p><script>hidden()</script>"
        working, _, _, _ = prepare_book(BookSource("book.html", html), 10)
        self.assertEqual(working, "A real paragraph.\n\nAnother.\nLine.")
        markdown = b"# Heading\r\n\r\n**Prose**"
        working, encoding, _, chunks = prepare_book(BookSource("book.md", markdown), 10)
        self.assertEqual(working, "# Heading\n\n**Prose**")
        self.assertEqual(encoding, "utf-8")
        self.assertEqual(chunks[-1].original_end, len(markdown))
