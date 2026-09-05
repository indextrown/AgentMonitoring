#!/usr/bin/env python3
"""Render Markdown tech specs as deterministic, self-contained HTML files."""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import tempfile
import unicodedata
from collections.abc import Iterable
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

SPEC_KIND = "tech-spec"
DEFAULT_SPEC_DIRECTORY = Path("docs/tech-specs")
SOURCE_FILE_NAME = "tech-spec.md"
OUTPUT_FILE_NAME = "tech-spec.html"
FEATURE_DIRECTORY_PATTERN = re.compile(
    r"(?P<sequence>[0-9]{3})-(?P<slug>[a-z0-9]+(?:-[a-z0-9]+)*)"
)
CONTROL_FIELDS = {"kind", "title", "html"}
META_LABELS = {
    "status": "상태",
    "owner": "작성자",
    "reviewers": "리뷰어",
    "last_updated": "마지막 수정",
    "related_issue": "관련 이슈",
}

PAGE_STYLE = """
:root {
  color-scheme: light;
  --background: #f5f7fb;
  --surface: #ffffff;
  --text: #20242c;
  --muted: #687083;
  --line: #e2e6ef;
  --accent: #315efb;
  --code: #f0f3f9;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--background);
  color: var(--text);
  font-family: Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 17px;
  line-height: 1.72;
  word-break: keep-all;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 760px) 220px;
  gap: 48px;
  max-width: 1100px;
  margin: 0 auto;
  padding: 64px 32px 96px;
}
article {
  min-width: 0;
  padding: 56px 64px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20px;
  box-shadow: 0 18px 45px rgba(28, 39, 65, 0.06);
}
h1, h2, h3, h4, h5, h6 {
  margin: 2em 0 0.65em;
  line-height: 1.28;
  letter-spacing: -0.025em;
}
h1 { margin-top: 0; font-size: 2.3rem; }
h2 { padding-top: 0.3em; font-size: 1.55rem; border-top: 1px solid var(--line); }
h3 { font-size: 1.2rem; }
p, ul, ol, table, pre, blockquote { margin: 0.8em 0 1.2em; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.35em; }
a { color: var(--accent); text-underline-offset: 0.18em; }
code {
  padding: 0.14em 0.35em;
  background: var(--code);
  border-radius: 5px;
  font-family: "SFMono-Regular", Consolas, monospace;
  font-size: 0.9em;
}
pre {
  overflow-x: auto;
  padding: 18px 20px;
  background: #171b26;
  color: #f7f8fb;
  border-radius: 12px;
  line-height: 1.55;
}
pre code { padding: 0; background: transparent; color: inherit; }
blockquote {
  padding: 0.15em 1.1em;
  color: var(--muted);
  border-left: 4px solid var(--accent);
}
table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
th, td { padding: 11px 13px; text-align: left; vertical-align: top; border: 1px solid var(--line); }
th { background: var(--code); }
.metadata {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 24px;
  margin: -0.25em 0 2.5em;
  padding: 18px 20px;
  background: var(--code);
  border-radius: 12px;
}
.metadata div { min-width: 0; }
.metadata dt { color: var(--muted); font-size: 0.78rem; font-weight: 700; }
.metadata dd { margin: 2px 0 0; overflow-wrap: anywhere; }
nav { position: sticky; top: 32px; align-self: start; }
nav strong { display: block; margin-bottom: 10px; font-size: 0.82rem; color: var(--muted); }
nav ol { margin: 0; padding: 0; list-style: none; font-size: 0.9rem; }
nav li + li { margin-top: 8px; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--accent); }
hr { margin: 2em 0; border: 0; border-top: 1px solid var(--line); }
@media (max-width: 900px) {
  .layout { display: block; padding: 24px 16px 56px; }
  article { padding: 36px 24px; border-radius: 14px; }
  nav { display: none; }
}
@media (max-width: 520px) {
  body { font-size: 16px; }
  h1 { font-size: 1.85rem; }
  .metadata { grid-template-columns: 1fr; }
}
""".strip()


class SpecError(ValueError):
    """Raised when a source document cannot be synchronized safely."""


def parse_scalar(value: str) -> Any:
    value = value.strip()
    if not value:
        return ""
    if value in {"[]", "{}"} or value.startswith(('"', "'", "[", "{")):
        try:
            if value.startswith("'") and value.endswith("'"):
                return value[1:-1].replace("''", "'")
            return json.loads(value)
        except json.JSONDecodeError:
            return value.strip("\"'")
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    if value.lower() in {"null", "~"}:
        return None
    return value


def split_frontmatter(markdown: str) -> tuple[dict[str, Any], str]:
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != "---":
        raise SpecError("Markdown 파일에 YAML frontmatter가 없어요.")

    try:
        closing_index = next(
            index
            for index, line in enumerate(lines[1:], start=1)
            if line.strip() == "---"
        )
    except StopIteration as error:
        raise SpecError("YAML frontmatter의 닫는 구분선이 없어요.") from error

    metadata: dict[str, Any] = {}
    for raw_line in lines[1:closing_index]:
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if ":" not in raw_line:
            raise SpecError(f"frontmatter 항목을 해석할 수 없어요: {raw_line}")
        key, value = raw_line.split(":", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", key):
            raise SpecError(f"frontmatter 키가 올바르지 않아요: {key}")
        metadata[key] = parse_scalar(value)

    body = "\n".join(lines[closing_index + 1 :]).strip() + "\n"
    return metadata, body


def safe_link(url: str) -> str | None:
    candidate = html.unescape(url.strip())
    parsed = urlsplit(candidate)
    if parsed.scheme.lower() in {"http", "https", "mailto"}:
        return candidate
    if not parsed.scheme and candidate.startswith(("./", "../", "/", "#")):
        return candidate
    return None


def render_inline(text: str) -> str:
    tokens: list[str] = []

    def store(fragment: str) -> str:
        tokens.append(fragment)
        return f"\ue000{len(tokens) - 1}\ue001"

    def replace_code(match: re.Match[str]) -> str:
        return store(f"<code>{html.escape(match.group(1))}</code>")

    def replace_link(match: re.Match[str]) -> str:
        label = html.escape(match.group(1))
        url = safe_link(match.group(2))
        if url is None:
            return store(label)
        return store(f'<a href="{html.escape(url, quote=True)}">{label}</a>')

    tokenized = re.sub(r"`([^`\n]+)`", replace_code, text)
    tokenized = re.sub(r"\[([^\]\n]+)\]\(([^)\s]+)\)", replace_link, tokenized)
    escaped = html.escape(tokenized)
    escaped = re.sub(r"\*\*([^*\n]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", escaped)

    for index, fragment in enumerate(tokens):
        escaped = escaped.replace(f"\ue000{index}\ue001", fragment)
    return escaped


def slugify(text: str, used: set[str]) -> str:
    normalized = unicodedata.normalize("NFKC", re.sub(r"[`*_]", "", text)).lower()
    slug = re.sub(r"[^\w가-힣]+", "-", normalized, flags=re.UNICODE).strip("-")
    slug = slug or "section"
    base = slug
    suffix = 2
    while slug in used:
        slug = f"{base}-{suffix}"
        suffix += 1
    used.add(slug)
    return slug


def table_cells(line: str) -> list[str]:
    stripped = line.strip().strip("|")
    return [cell.strip() for cell in stripped.split("|")]


def is_table_separator(line: str) -> bool:
    cells = table_cells(line)
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def render_markdown(body: str) -> tuple[str, list[tuple[int, str, str]]]:
    lines = body.splitlines()
    rendered: list[str] = []
    headings: list[tuple[int, str, str]] = []
    used_ids: set[str] = set()
    paragraph: list[str] = []
    list_type: str | None = None
    list_items: list[str] = []

    def flush_paragraph() -> None:
        if paragraph:
            rendered.append(
                f"<p>{render_inline(' '.join(part.strip() for part in paragraph))}</p>"
            )
            paragraph.clear()

    def flush_list() -> None:
        nonlocal list_type
        if list_type is not None:
            items = "".join(f"<li>{render_inline(item)}</li>" for item in list_items)
            rendered.append(f"<{list_type}>{items}</{list_type}>")
            list_items.clear()
            list_type = None

    index = 0
    while index < len(lines):
        line = lines[index]

        if line.startswith("```"):
            flush_paragraph()
            flush_list()
            language = line[3:].strip()
            code_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].startswith("```"):
                code_lines.append(lines[index])
                index += 1
            language_class = ""
            if language and re.fullmatch(r"[A-Za-z0-9_+.-]+", language):
                language_class = (
                    f' class="language-{html.escape(language, quote=True)}"'
                )
            code = html.escape("\n".join(code_lines))
            rendered.append(f"<pre><code{language_class}>{code}</code></pre>")
            index += 1
            continue

        if not line.strip():
            flush_paragraph()
            flush_list()
            index += 1
            continue

        heading_match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if heading_match:
            flush_paragraph()
            flush_list()
            level = len(heading_match.group(1))
            label = heading_match.group(2).rstrip("#").strip()
            heading_id = slugify(label, used_ids)
            rendered.append(
                f'<h{level} id="{html.escape(heading_id, quote=True)}">{render_inline(label)}</h{level}>'
            )
            if 2 <= level <= 3:
                headings.append((level, label, heading_id))
            index += 1
            continue

        if (
            index + 1 < len(lines)
            and "|" in line
            and is_table_separator(lines[index + 1])
        ):
            flush_paragraph()
            flush_list()
            headers = table_cells(line)
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                rows.append(table_cells(lines[index]))
                index += 1
            header_html = "".join(f"<th>{render_inline(cell)}</th>" for cell in headers)
            row_html: list[str] = []
            for row in rows:
                padded = (row + [""] * len(headers))[: len(headers)]
                row_html.append(
                    "<tr>"
                    + "".join(f"<td>{render_inline(cell)}</td>" for cell in padded)
                    + "</tr>"
                )
            rendered.append(
                "<table><thead><tr>"
                + header_html
                + "</tr></thead><tbody>"
                + "".join(row_html)
                + "</tbody></table>"
            )
            continue

        unordered_match = re.match(r"^\s*[-+*]\s+(.+)$", line)
        ordered_match = re.match(r"^\s*\d+\.\s+(.+)$", line)
        if unordered_match or ordered_match:
            flush_paragraph()
            next_type = "ul" if unordered_match else "ol"
            if list_type is not None and list_type != next_type:
                flush_list()
            list_type = next_type
            list_items.append((unordered_match or ordered_match).group(1))
            index += 1
            continue

        if line.lstrip().startswith(">"):
            flush_paragraph()
            flush_list()
            quote_lines: list[str] = []
            while index < len(lines) and lines[index].lstrip().startswith(">"):
                quote_lines.append(lines[index].lstrip()[1:].lstrip())
                index += 1
            rendered.append(
                f"<blockquote><p>{render_inline(' '.join(quote_lines))}</p></blockquote>"
            )
            continue

        if re.fullmatch(r"\s*([-*_])(?:\s*\1){2,}\s*", line):
            flush_paragraph()
            flush_list()
            rendered.append("<hr>")
            index += 1
            continue

        if list_type is not None:
            flush_list()
        paragraph.append(line)
        index += 1

    flush_paragraph()
    flush_list()
    return "\n".join(rendered), headings


def display_value(value: Any) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value)
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    return str(value)


def render_metadata(metadata: dict[str, Any]) -> str:
    items: list[str] = []
    for key, value in metadata.items():
        if key in CONTROL_FIELDS:
            continue
        rendered_value = display_value(value).strip()
        if not rendered_value:
            continue
        label = META_LABELS.get(key, key.replace("_", " "))
        safe_value = render_inline(rendered_value)
        items.append(f"<div><dt>{html.escape(label)}</dt><dd>{safe_value}</dd></div>")
    if not items:
        return ""
    return '<dl class="metadata">' + "".join(items) + "</dl>"


def render_toc(headings: Iterable[tuple[int, str, str]]) -> str:
    links = [
        f'<li class="level-{level}"><a href="#{html.escape(anchor, quote=True)}">{html.escape(label)}</a></li>'
        for level, label, anchor in headings
        if level == 2
    ]
    if not links:
        return ""
    return (
        '<nav aria-label="문서 목차"><strong>목차</strong><ol>'
        + "".join(links)
        + "</ol></nav>"
    )


def document_title(metadata: dict[str, Any], body: str, source: Path) -> str:
    title = display_value(metadata.get("title", "")).strip()
    if title:
        return title
    for line in body.splitlines():
        match = re.match(r"^#\s+(.+)$", line)
        if match:
            return re.sub(r"[`*_]", "", match.group(1)).strip()
    return source.stem


def render_document(source: Path, markdown: str) -> str:
    metadata, body = split_frontmatter(markdown)
    if metadata.get("kind") != SPEC_KIND:
        raise SpecError(f"kind는 {SPEC_KIND!r}이어야 해요: {source}")

    article_body, headings = render_markdown(body)
    metadata_html = render_metadata(metadata)
    toc_html = render_toc(headings)
    title = document_title(metadata, body, source)
    digest = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="tech-spec-source" content="{html.escape(source.name, quote=True)}">
  <meta name="tech-spec-sha256" content="{digest}">
  <title>{html.escape(title)}</title>
  <style>{PAGE_STYLE}</style>
</head>
<body>
  <main class="layout">
    <article>
      {metadata_html}
      {article_body}
    </article>
    {toc_html}
  </main>
</body>
</html>
"""


def is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def validate_source_location(root: Path, source: Path) -> int:
    relative = source.relative_to(root)
    parts = relative.parts
    prefix = DEFAULT_SPEC_DIRECTORY.parts
    directory_match = (
        FEATURE_DIRECTORY_PATTERN.fullmatch(parts[-2]) if len(parts) >= 2 else None
    )
    if (
        len(parts) != len(prefix) + 2
        or parts[: len(prefix)] != prefix
        or parts[-1] != SOURCE_FILE_NAME
        or directory_match is None
        or directory_match.group("sequence") == "000"
    ):
        raise SpecError(
            "테크 스펙 Markdown은 "
            f"{DEFAULT_SPEC_DIRECTORY}/<sequence>-<feature-slug>/{SOURCE_FILE_NAME}에 "
            "저장해야 해요. sequence는 001부터 시작하는 세 자리 번호예요: "
            f"{relative}"
        )
    return int(directory_match.group("sequence"))


def output_path(root: Path, source: Path, metadata: dict[str, Any]) -> Path:
    expected = (source.parent / OUTPUT_FILE_NAME).resolve()
    configured = display_value(metadata.get("html", "")).strip()
    configured_path = (
        expected if not configured else (source.parent / configured).resolve()
    )
    if configured_path != expected:
        raise SpecError(
            f"HTML은 Markdown과 같은 폴더의 {OUTPUT_FILE_NAME}에 저장해야 해요: "
            f"{configured_path}"
        )
    if not is_within(expected, root):
        raise SpecError(f"HTML 출력 경로가 저장소 밖을 가리켜요: {expected}")
    return expected


def discover_sources(root: Path, requested: list[str]) -> list[Path]:
    if requested:
        sources = [
            (root / item).resolve()
            if not Path(item).is_absolute()
            else Path(item).resolve()
            for item in requested
        ]
    else:
        directory = (root / DEFAULT_SPEC_DIRECTORY).resolve()
        sources = sorted(directory.rglob("*.md")) if directory.exists() else []

    unique: list[Path] = []
    seen: set[Path] = set()
    for source in sources:
        if source in seen:
            continue
        if not is_within(source, root):
            raise SpecError(f"Markdown 경로가 저장소 밖을 가리켜요: {source}")
        if source.suffix.lower() != ".md" or not source.is_file():
            raise SpecError(f"Markdown 파일을 찾을 수 없어요: {source}")
        seen.add(source)
        unique.append(source)
    return unique


def atomic_write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def synchronize(
    root: Path, requested: list[str], check: bool
) -> tuple[list[Path], list[Path]]:
    updated: list[Path] = []
    stale: list[Path] = []
    sequence_directories: dict[int, Path] = {}

    for source in discover_sources(root, requested):
        markdown = source.read_text(encoding="utf-8")
        try:
            metadata, _ = split_frontmatter(markdown)
        except SpecError:
            if requested:
                raise
            continue
        if metadata.get("kind") != SPEC_KIND:
            if requested:
                raise SpecError(f"kind는 {SPEC_KIND!r}이어야 해요: {source}")
            continue
        sequence = validate_source_location(root, source)
        previous_directory = sequence_directories.get(sequence)
        if previous_directory is not None and previous_directory != source.parent:
            raise SpecError(
                f"테크 스펙 폴더 번호 {sequence:03d}이 중복됐어요: "
                f"{previous_directory.relative_to(root)}, {source.parent.relative_to(root)}"
            )
        sequence_directories[sequence] = source.parent
        destination = output_path(root, source, metadata)
        expected = render_document(source, markdown)
        current = (
            destination.read_text(encoding="utf-8") if destination.exists() else None
        )
        if current == expected:
            continue
        stale.append(destination)
        if not check:
            atomic_write(destination, expected)
            updated.append(destination)

    return updated, stale


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Markdown 테크 스펙과 같은 내용을 담은 HTML을 생성해요."
    )
    parser.add_argument("paths", nargs="*", help="저장소 루트 기준 Markdown 경로")
    parser.add_argument("--root", default=".", help="대상 저장소 루트")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check", action="store_true", help="HTML이 최신인지 확인만 해요."
    )
    mode.add_argument(
        "--hook", action="store_true", help="Codex 훅용 JSON 결과를 출력해요."
    )
    return parser


def run(arguments: argparse.Namespace) -> int:
    root = Path(arguments.root).resolve()
    if not root.is_dir():
        raise SpecError(f"저장소 루트를 찾을 수 없어요: {root}")

    updated, stale = synchronize(root, arguments.paths, arguments.check)
    if arguments.hook:
        print(json.dumps({}, ensure_ascii=False))
        return 0
    if arguments.check:
        if stale:
            for path in stale:
                print(f"STALE {path.relative_to(root)}")
            return 1
        print("모든 테크 스펙 HTML이 최신 상태예요.")
        return 0
    if updated:
        for path in updated:
            print(f"UPDATED {path.relative_to(root)}")
    else:
        print("변경할 테크 스펙 HTML이 없어요.")
    return 0


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        return run(arguments)
    except (OSError, SpecError) as error:
        if arguments.hook:
            print(
                json.dumps(
                    {"systemMessage": f"테크 스펙 HTML 동기화 실패: {error}"},
                    ensure_ascii=False,
                )
            )
            return 0
        print(f"ERROR {error}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
