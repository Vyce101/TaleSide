"""Prepare book text and preserve source offsets for plain-text formats."""

import codecs
import re
from bisect import bisect_left
from dataclasses import dataclass
from pathlib import PureWindowsPath

from .book_documents import epub_text, html_text

BOUNDARIES = (
    re.compile(r"\n(?:[^\S\n]*\n)+"),
    re.compile(r"\n"),
    re.compile(r"[.!?;:,…。！？；：](?:[\"'”’»)\]]*)"),
    re.compile(r"[^\S\n]"),
)


@dataclass(frozen=True)
class BookSource:
    filename: str
    original: bytes
    name: str | None = None


@dataclass(frozen=True)
class Chunk:
    start: int
    end: int
    original_start: int
    original_end: int


def decode_txt(original):
    if original.startswith(codecs.BOM_UTF8):
        encoding, bom_size = "utf-8", len(codecs.BOM_UTF8)
    elif original.startswith(codecs.BOM_UTF32_LE) or original.startswith(codecs.BOM_UTF32_BE):
        raise ValueError("Use UTF-8 or BOM-marked UTF-16 text.")
    elif original.startswith(codecs.BOM_UTF16_LE):
        encoding, bom_size = "utf-16-le", len(codecs.BOM_UTF16_LE)
    elif original.startswith(codecs.BOM_UTF16_BE):
        encoding, bom_size = "utf-16-be", len(codecs.BOM_UTF16_BE)
    else:
        encoding, bom_size = "utf-8", 0

    text = original[bom_size:].decode(encoding)
    if "\x00" in text:
        raise ValueError("The file contains a NUL character. Use UTF-8 or BOM-marked UTF-16 text.")
    return text, encoding, bom_size


def normalize_lines(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def chunk_end(text, start, max_size):
    search_distance = max_size // 10
    limit = min(start + max_size, len(text))
    if limit == len(text) or not search_distance:
        return limit
    earliest = max(start + 1, limit - search_distance)
    for boundary in BOUNDARIES:
        end = max(
            (match.end() for match in boundary.finditer(text, start, limit)),
            default=0,
        )
        if end >= earliest:
            return end
    return limit


def prepare_book(source, max_size):
    if not source.filename or PureWindowsPath(source.filename).name != source.filename:
        raise ValueError("Supply a filename without a directory for each book.")
    suffix = PureWindowsPath(source.filename).suffix.lower()
    try:
        if suffix in {".txt", ".md", ".markdown"}:
            decoded, encoding, bom_size = decode_txt(source.original)
        elif suffix in {".htm", ".html", ".epub"}:
            decoded = epub_text(source.original) if suffix == ".epub" else html_text(source.original)
            encoding, bom_size = "extracted", 0
        else:
            raise ValueError("Select a TXT, Markdown, HTML, or EPUB file.")
    except (ValueError, UnicodeError) as error:
        raise ValueError(f"{source.filename}: {error}") from error

    working = normalize_lines(decoded)
    if not working.strip():
        raise ValueError(f"{source.filename}: the book contains no text.")

    if encoding == "extracted":
        chunks = []
        start = 0
        while start < len(working):
            end = chunk_end(working, start, max_size)
            chunks.append(Chunk(start, end, 0, 0))
            start = end
        return working, encoding, bom_size, tuple(chunks)

    # Each CRLF adds one encoded character to the source range.
    crlf_positions = [match.start() - index for index, match in enumerate(re.finditer(r"\r\n", decoded))]
    carriage_return_size = len("\r".encode(encoding))
    chunks = []
    start, source_start = 0, bom_size
    while start < len(working):
        end = chunk_end(working, start, max_size)
        crlf_count = bisect_left(crlf_positions, end) - bisect_left(crlf_positions, start)
        source_end = source_start + len(working[start:end].encode(encoding)) + crlf_count * carriage_return_size
        chunks.append(Chunk(start, end, source_start, source_end))
        start, source_start = end, source_end
    return working, encoding, bom_size, tuple(chunks)
