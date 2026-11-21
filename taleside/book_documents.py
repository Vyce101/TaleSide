"""Extract readable text from HTML and EPUB documents without opening external resources."""

import codecs
import io
import posixpath
import re
import zipfile
import zlib
from html.parser import HTMLParser
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

MAX_EPUB_EXPANDED_BYTES = 256 * 1024 * 1024
VOID = set("area base br col embed hr img input link meta param source track wbr".split())
BLOCKS = set("address article aside blockquote dd div dl dt figcaption figure footer h1 h2 h3 h4 h5 h6 header hr li main p pre section table tr".split())
HIDDEN = set("head script style template noscript nav svg canvas iframe audio video object".split())
HIDDEN_STYLE = re.compile(r"(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)", re.I)


class BookHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = []

    def handle_starttag(self, tag, attrs):
        if tag == "body" and self.hidden[:1] == ["head"]:
            self.hidden.clear()
        if self.hidden:
            if tag not in VOID:
                self.hidden.append(tag)
            return
        options = dict(attrs)
        if tag in HIDDEN or "hidden" in options or (options.get("aria-hidden") or "").lower() == "true" or HIDDEN_STYLE.search(options.get("style") or ""):
            if tag not in VOID:
                self.hidden.append(tag)
            return
        if tag in BLOCKS:
            self.parts.append("\n\n")
        elif tag == "br":
            self.parts.append("\n")
        elif tag in {"td", "th"}:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag in self.hidden:
                index = len(self.hidden) - 1 - self.hidden[::-1].index(tag)
                del self.hidden[index:]
            return
        if tag in BLOCKS:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(re.sub(r"\s+", " ", data))


def html_text(original):
    encoding = "utf-8-sig"
    if original.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encoding = "utf-16"
    else:
        charset = re.search(rb"<meta\b[^>]*?\bcharset\s*=\s*[\"']?([a-zA-Z0-9_-]+)", original[:4096], re.I)
        if charset:
            encoding = charset.group(1).decode("ascii")
    try:
        document = original.decode(encoding)
    except (LookupError, UnicodeError) as error:
        raise ValueError("The HTML text could not be decoded.") from error
    if "\x00" in document:
        raise ValueError("The HTML contains an unreadable NUL character.")
    parser = BookHTML()
    parser.feed(document)
    parser.close()
    text = re.sub(r" +", " ", "".join(parser.parts))
    text = re.sub(r"[ \t]*\n[ \t]*", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def member_path(parent, href):
    url = urlsplit(href)
    path = posixpath.normpath(posixpath.join(parent, unquote(url.path)))
    if url.scheme or url.netloc or path in {".", ".."} or path.startswith(("/", "../")) or "\\" in path:
        raise ValueError("The EPUB contains an invalid reading-order path.")
    return path


def epub_text(original):
    read_bytes = 0
    try:
        with zipfile.ZipFile(io.BytesIO(original)) as archive:
            def read(path):
                nonlocal read_bytes
                member = archive.getinfo(path)
                if member.file_size > MAX_EPUB_EXPANDED_BYTES - read_bytes:
                    raise ValueError("The EPUB expands to more than 256 MiB.")
                data = archive.read(member)
                read_bytes += len(data)
                return data

            def xml(path):
                data = read(path)
                if re.search(rb"<!\s*(?:DOCTYPE|ENTITY)\b", data.replace(b"\0", b""), re.I):
                    raise ValueError("The EPUB package contains unsupported XML declarations.")
                return ElementTree.fromstring(data)

            rootfile = xml("META-INF/container.xml").find(".//{*}rootfile")
            package_path = member_path("", rootfile.attrib["full-path"])
            package = xml(package_path)
            directory = posixpath.dirname(package_path)
            manifest = {item.attrib["id"]: item.attrib for item in package.findall("{*}manifest/{*}item")}
            toc_paths = {
                member_path(directory, entry.attrib["href"]) for entry in package.findall("{*}guide/{*}reference")
                if entry.get("type") == "toc"
            }
            sections = []
            spine = package.find("{*}spine")
            if spine is None:
                raise ValueError("The EPUB has no reading order.")
            for reference in spine.findall("{*}itemref"):
                if reference.get("linear") == "no" or reference.get("idref") == spine.get("toc"):
                    continue
                item = manifest[reference.attrib["idref"]]
                if "nav" in item.get("properties", "").split() or item.get("media-type") not in {"application/xhtml+xml", "text/html"}:
                    continue
                path = member_path(directory, item["href"])
                if path not in toc_paths:
                    text = html_text(read(path))
                    if text:
                        sections.append(text)
        return "\n\n".join(sections)
    except (zipfile.BadZipFile, KeyError, AttributeError, ElementTree.ParseError, RuntimeError, NotImplementedError, OSError, zlib.error) as error:
        raise ValueError("The EPUB could not be read. Choose a valid, unencrypted EPUB.") from error
