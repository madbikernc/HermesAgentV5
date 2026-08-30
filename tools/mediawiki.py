#!/usr/bin/env python3
# Version: 1.3.1
#
# 1.3.1 (2026-08-30) — HermesAgentV5 consolidation: REPO_DIR default and the MediaWiki
# User-Agent string (including its GitHub URL) repointed from HermesAgentV4 to
# HermesAgentV5.
#
"""
1.3.0 — follow-up security-review fix: vault_get()'s retry loop now catches
subprocess.TimeoutExpired on each attempt — a *complete* Vaultwarden outage
(both attempts hitting the full 60s timeout) previously still hard-exited
via an uncaught exception instead of this function's own clean error path.

1.2.0 — two fixes from a security review: vault_get() now retries once at
timeout=60 (a single timeout=30 attempt could hard-exit on a transient
Vaultwarden failure a second attempt would have recovered from — same
pattern as tools/hermes_game_backup_common.py); existing_image_titles() now
pages through the API's `continue` token instead of a single ailimit=500
call, since the near-duplicate-filename guard silently stopped protecting
uploads once the wiki's image library grew past 500 files.

MediaWiki Action API client for the Firmament wiki (homesyn NAS, 10.129.1.165).
Uses a Bot Password (Special:BotPasswords) — never the account's normal login
password. Ported from v1 (HermesAgent/scripts/mediawiki.py); the only real
change is credential sourcing: v1 read a plaintext ~/.hermes/config/mediawiki.json,
this project's own constraint (§2b, "Credentials live in Vaultwarden") means
that file must not exist here — credentials are fetched fresh from Vaultwarden
via tools/vault-get-secret.sh on every run instead, same pattern as every other
credential this project uses.

1.1.0 adds two guardrails found necessary from real persona use (2026-08-03,
see LESSONS_LEARNED.md): `upload` now refuses a near-duplicate filename that
differs only in case beyond the first letter (MediaWiki auto-capitalizes just
that one character, so 'Sintra.png' and 'SINTRA.png' are two distinct files,
not the same one — this produced a real orphaned duplicate); and the new
`blog-entry` command generates its own date heading in code rather than
asking a model to type one, after a real page shipped with a literal,
unsubstituted '$DATE' placeholder.

Usage:
  python3 mediawiki.py read "Page Title"
  python3 mediawiki.py search "some query" [--limit 10]
  python3 mediawiki.py edit "Page Title" --summary "why" (--text "..." | --file path | --stdin)
  python3 mediawiki.py append "Page Title" --summary "why" (--text "..." | --file path | --stdin)
  python3 mediawiki.py blog-entry "Page/Daily-Blog" --summary "why" (--text "..." | --file path | --stdin)
  python3 mediawiki.py upload "File.png" --file /local/path.png --comment "why" [--text "wikitext"] [--force]
  python3 mediawiki.py recent [--limit 10]
  python3 mediawiki.py category "Category Name" [--limit 50]
"""
import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import date
from http.cookiejar import CookieJar
from pathlib import Path

API_URL = "http://10.129.1.165/mediawiki/api.php"
VAULT_ITEM = "Hermes Wiki Bot"
REPO_DIR = Path(os.environ.get("HERMES_REPO_DIR", str(Path.home() / "HermesAgentV5")))
VAULT_SCRIPT = REPO_DIR / "tools" / "vault-get-secret.sh"
USER_AGENT = "HermesAgentV5-MediaWiki/1.0 (https://github.com/madbikernc/HermesAgentV5; ops bot)"

# Matches a Markdown table separator row: |---|---|, ---|---, :--|--:, etc.
_MD_TABLE_SEP_RE = re.compile(r'^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$')
# Matches a Markdown ATX heading: #, ##, ... up to ######, followed by a space and text.
_MD_HEADING_RE = re.compile(r'^#{1,6}\s+\S')
# Matches a Markdown image/link: ![alt](url) or [text](url). MediaWiki's
# equivalent is [[File:...]] for images and [url text] (single brackets, no
# parens) for external links.
_MD_IMAGE_OR_LINK_RE = re.compile(r'!?\[[^\]\[]*\]\([^)]+\)')


def find_markdown_in_wikitext(text):
    """LLM callers default to Markdown far more often than MediaWiki's wikitext
    syntax (v1 finding, 2026-07-17: a model wrote GFM tables and '#' headings
    twice in a row despite explicit instructions and a documented example, and
    on a third attempt "fixed" a flagged separator line by deleting it while
    leaving bare Markdown-style rows behind, which still isn't valid wikitext).
    This is a deterministic backstop — catch it here rather than relying on a
    model reading and following skill documentation, which has not proven
    reliable across three separate attempts. Returns a list of human-readable
    problems, empty if none found."""
    problems = []
    lines = text.split("\n")
    in_table_block = False
    for i, line in enumerate(lines, start=1):
        stripped = line.strip()

        if stripped.startswith("{|"):
            in_table_block = True
            continue
        if stripped == "|}":
            in_table_block = False
            continue
        if in_table_block:
            continue  # |-, |, !! etc. inside a real {| ... |} block are fine

        if _MD_HEADING_RE.match(line):
            problems.append(
                f"Line {i}: Markdown heading ({line.strip()!r}). "
                "MediaWiki headings use '== Heading ==' syntax, not leading '#'."
            )
        if _MD_TABLE_SEP_RE.match(line):
            problems.append(
                f"Line {i}: Markdown table separator row ({line.strip()!r}). "
                'MediaWiki tables use {| class="wikitable" ... |} syntax, not '
                "pipes-and-dashes."
            )
        elif stripped.startswith("|") and stripped.endswith("|") and stripped.count("|") >= 3:
            problems.append(
                f"Line {i}: pipe-delimited row outside a {{| ... |}} block "
                f"({line.strip()!r}). This is not valid wikitext even without "
                'a separator row — wrap the whole table in {| class="wikitable" '
                "... |}, with |- between rows and ! for header cells."
            )

        for m in _MD_IMAGE_OR_LINK_RE.finditer(line):
            is_image = m.group(0).startswith("!")
            if is_image:
                problems.append(
                    f"Line {i}: Markdown image link ({m.group(0)!r}). MediaWiki "
                    "renders this as a literal clickable link, not inline — it "
                    "does not parse ![alt](url) syntax at all. Upload the file "
                    "with `mediawiki.py upload` and embed it with "
                    "[[File:Name.png|thumb|300px|caption]] instead."
                )
            else:
                problems.append(
                    f"Line {i}: Markdown link ({m.group(0)!r}). MediaWiki external "
                    "links use single brackets: [https://url display text]."
                )
    return problems


def vault_get(field):
    # Retries once at timeout=60 rather than a single timeout=30 attempt: a
    # legitimate single-retry Vaultwarden recovery (vault-get-secret.sh's own
    # internal login/unlock/sync/get retry) can take ~32s, long enough that a
    # single timeout=30 call here would hard-exit on a transient failure that
    # a second attempt would have cleanly recovered from. Same pattern as
    # tools/hermes_game_backup_common.py's vault_get().
    last_stderr = ""
    for _ in range(2):
        try:
            result = subprocess.run(
                [str(VAULT_SCRIPT), VAULT_ITEM, field],
                capture_output=True, text=True, timeout=60,
            )
        except subprocess.TimeoutExpired:
            last_stderr = "timed out after 60s"
            continue
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        last_stderr = result.stderr.strip()
    print(f"Could not fetch '{field}' from vault item '{VAULT_ITEM}': {last_stderr}")
    sys.exit(1)


def load_config():
    return {
        "url": API_URL,
        "username": vault_get("username"),
        "password": vault_get("password"),
    }


class Wiki:
    def __init__(self, cfg):
        self.api_url = cfg["url"]
        self.username = cfg["username"]
        self.password = cfg["password"]
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(CookieJar())
        )

    def _call(self, params, method="GET"):
        params = {**params, "format": "json"}
        if method == "GET":
            url = f"{self.api_url}?{urllib.parse.urlencode(params)}"
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        else:
            data = urllib.parse.urlencode(params).encode()
            req = urllib.request.Request(
                self.api_url, data=data, headers={"User-Agent": USER_AGENT}
            )
        try:
            with self.opener.open(req, timeout=15) as resp:
                return json.load(resp)
        except urllib.error.URLError as e:
            print(f"Request to MediaWiki API failed: {e}")
            sys.exit(1)

    def _token(self, token_type):
        resp = self._call({"action": "query", "meta": "tokens", "type": token_type})
        return resp["query"]["tokens"][f"{token_type}token"]

    def login(self):
        login_token = self._token("login")
        resp = self._call({
            "action": "login",
            "lgname": self.username,
            "lgpassword": self.password,
            "lgtoken": login_token,
        }, method="POST")
        result = resp.get("login", {}).get("result")
        if result != "Success":
            print(f"Login failed: {resp.get('login', {})}")
            sys.exit(1)

    def read(self, title):
        resp = self._call({
            "action": "query",
            "prop": "revisions",
            "titles": title,
            "rvslots": "main",
            "rvprop": "content|timestamp",
        })
        pages = resp["query"]["pages"]
        page = next(iter(pages.values()))
        if "missing" in page:
            print(f"Page not found: {title}")
            sys.exit(1)
        rev = page["revisions"][0]
        print(f"=== {page['title']} (last edited {rev['timestamp']}) ===\n")
        print(rev["slots"]["main"]["*"])

    def search(self, query, limit):
        resp = self._call({
            "action": "query",
            "list": "search",
            "srsearch": query,
            "srlimit": limit,
        })
        results = resp["query"]["search"]
        if not results:
            print("No results.")
            return
        for r in results:
            snippet = r["snippet"].replace('<span class="searchmatch">', "").replace("</span>", "")
            print(f"- {r['title']}  ({r['wordcount']} words)  {snippet}")

    def edit(self, title, text, summary, append=False):
        csrf_token = self._token("csrf")
        params = {
            "action": "edit",
            "title": title,
            "summary": summary,
            "bot": "1",
            "token": csrf_token,
        }
        params["appendtext" if append else "text"] = text
        resp = self._call(params, method="POST")
        if "edit" in resp and resp["edit"].get("result") == "Success":
            newrev = resp["edit"].get("newrevid", "?")
            print(f"Saved '{title}' — new revision {newrev}")
        else:
            print(f"Edit failed: {resp}")
            sys.exit(1)

    def blog_entry(self, title, body_text, summary):
        """Append a dated entry to a '<Page>/Daily-Blog'-style subpage. The date
        heading is generated here, in code, never left for a model to type —
        a real page shipped with a literal, unsubstituted '$DATE' placeholder
        because that was previously the caller's job (LESSONS_LEARNED.md,
        2026-08-03). Newest-first, same convention as the Changelog pages
        hermes-wiki-sync.py maintains."""
        today = date.today().isoformat()
        new_section = f"== {today} ==\n\n{body_text.strip()}\n"

        resp = self._call({
            "action": "query", "prop": "revisions", "titles": title,
            "rvslots": "main", "rvprop": "content",
        })
        page = next(iter(resp["query"]["pages"].values()))

        if "missing" in page:
            persona = title.split("/", 1)[0]
            header = (
                "== Daily Blog ==\n"
                f"A personal log of daily activities, observations, and reflections from {persona}.\n\n"
                "----\n\n"
            )
            new_text = header + new_section
        else:
            body = page["revisions"][0]["slots"]["main"]["*"]
            split_at = body.find("\n== ")
            if split_at == -1:
                new_text = body.rstrip() + "\n\n" + new_section
            else:
                new_text = body[:split_at].rstrip() + "\n\n" + new_section.rstrip() + "\n" + body[split_at:]

        self.edit(title, new_text, summary, append=False)

    def _call_multipart(self, fields, files):
        """action=upload needs multipart/form-data (a binary file field can't go
        through urlencode like every other action in this script does)."""
        boundary = uuid.uuid4().hex
        parts = []
        for name, value in fields.items():
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
            parts.append(f"{value}\r\n".encode())
        for name, (filename, content, content_type) in files.items():
            parts.append(f"--{boundary}\r\n".encode())
            parts.append(
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
            )
            parts.append(f"Content-Type: {content_type}\r\n\r\n".encode())
            parts.append(content)
            parts.append(b"\r\n")
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)

        req = urllib.request.Request(
            self.api_url,
            data=body,
            headers={
                "User-Agent": USER_AGENT,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with self.opener.open(req, timeout=60) as resp:
                return json.load(resp)
        except urllib.error.URLError as e:
            print(f"Request to MediaWiki API failed: {e}")
            sys.exit(1)

    def existing_image_titles(self):
        # Pages through the full image list via the API's own `continue`
        # token instead of a single ailimit=500 call. Found in a security
        # review: the near-duplicate-filename guard below (the exact fix for
        # the real SINTRA.png/Sintra.png orphaned-duplicate incident) only
        # ever checked the first 500 images, so once the wiki's library grew
        # past that, a colliding upload past image #500 would be silently
        # approved with no warning that the check was incomplete —
        # reproducing the bug this guard exists to prevent. Capped at 20
        # pages (10,000 images) so a pathological response can't loop forever.
        titles = []
        params = {"action": "query", "list": "allimages", "ailimit": "500", "aiprop": "name"}
        for _ in range(20):
            resp = self._call(params)
            titles.extend(f"File:{img['name']}" for img in resp["query"]["allimages"])
            aicontinue = resp.get("continue", {}).get("aicontinue")
            if not aicontinue:
                break
            params = {**params, "aicontinue": aicontinue}
        return titles

    def upload(self, filename, filepath, comment, text=None, force=False):
        if not force:
            target = f"File:{filename[:1].upper()}{filename[1:]}" if filename else "File:"
            collisions = [t for t in self.existing_image_titles()
                          if t.lower() == target.lower() and t != target]
            if collisions:
                print(f"REJECTED: '{filename}' looks like a near-duplicate of an existing file: "
                      f"{collisions}")
                print("MediaWiki only auto-capitalizes the first letter of a filename — "
                      "'SINTRA.png' and 'Sintra.png' are two different files, not the same one. "
                      "Reuse the existing filename exactly (matching its case beyond the first "
                      "letter), or pass --force if a genuinely new, separate file is intended.")
                sys.exit(1)
        csrf_token = self._token("csrf")
        content = Path(filepath).read_bytes()
        content_type = mimetypes.guess_type(filepath)[0] or "application/octet-stream"
        fields = {
            "action": "upload",
            "filename": filename,
            "comment": comment,
            "token": csrf_token,
            "ignorewarnings": "1",
            "format": "json",
        }
        if text is not None:
            fields["text"] = text
        files = {"file": (Path(filepath).name, content, content_type)}
        resp = self._call_multipart(fields, files)
        result = resp.get("upload", {}).get("result")
        if result == "Success":
            info = resp["upload"].get("imageinfo", {})
            print(f"Uploaded 'File:{filename}' — {info.get('url', '(no url in response)')}")
        else:
            print(f"Upload failed: {resp}")
            sys.exit(1)

    def recent(self, limit):
        resp = self._call({
            "action": "query",
            "list": "recentchanges",
            "rcprop": "title|user|timestamp|comment",
            "rclimit": limit,
        })
        for c in resp["query"]["recentchanges"]:
            print(f"- {c['timestamp']}  {c['user']}  {c['title']}  {c.get('comment', '')}")

    def category(self, name, limit):
        if not name.lower().startswith("category:"):
            name = f"Category:{name}"
        resp = self._call({
            "action": "query",
            "list": "categorymembers",
            "cmtitle": name,
            "cmlimit": limit,
        })
        members = resp["query"]["categorymembers"]
        if not members:
            print("No pages in this category.")
            return
        for m in members:
            print(f"- {m['title']}")


def check_markdown_or_exit(text):
    problems = find_markdown_in_wikitext(text)
    if not problems:
        return
    print("REJECTED: this content looks like Markdown, not MediaWiki wikitext:")
    for p in problems:
        print(f"  - {p}")
    print()
    print("Rewrite using wikitext syntax (== Heading ==, {| class=\"wikitable\" ... |} "
          "for tables) and retry. Pass --force to save anyway if this is a false positive.")
    sys.exit(1)


def resolve_text(args):
    if args.stdin:
        return sys.stdin.read()
    if args.file:
        return Path(args.file).read_text()
    if args.text is not None:
        return args.text
    print("Provide content via --text, --file, or --stdin")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="MediaWiki Action API client")
    sub = parser.add_subparsers(dest="command", required=True)

    p_read = sub.add_parser("read", help="Print a page's current wikitext")
    p_read.add_argument("title")

    p_search = sub.add_parser("search", help="Full-text search")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=10)

    p_edit = sub.add_parser("edit", help="Replace a page's content")
    p_edit.add_argument("title")
    p_edit.add_argument("--summary", required=True)
    p_edit.add_argument("--text")
    p_edit.add_argument("--file")
    p_edit.add_argument("--stdin", action="store_true")
    p_edit.add_argument("--force", action="store_true",
                         help="Skip the Markdown-in-wikitext validation check")

    p_append = sub.add_parser("append", help="Append content to a page")
    p_append.add_argument("title")
    p_append.add_argument("--summary", required=True)
    p_append.add_argument("--text")
    p_append.add_argument("--file")
    p_append.add_argument("--stdin", action="store_true")
    p_append.add_argument("--force", action="store_true",
                           help="Skip the Markdown-in-wikitext validation check")

    p_blog = sub.add_parser("blog-entry", help="Append a dated entry to a Daily-Blog subpage "
                             "(date is generated by this tool — never write $DATE or a date yourself)")
    p_blog.add_argument("title", help="e.g. 'Sintra/Daily-Blog'")
    p_blog.add_argument("--summary", required=True)
    p_blog.add_argument("--text")
    p_blog.add_argument("--file")
    p_blog.add_argument("--stdin", action="store_true")
    p_blog.add_argument("--force", action="store_true",
                         help="Skip the Markdown-in-wikitext validation check")

    p_upload = sub.add_parser("upload", help="Upload a file/image")
    p_upload.add_argument("filename", help="Target wiki filename, e.g. Sintra.png")
    p_upload.add_argument("--file", required=True, help="Local path to the file to upload")
    p_upload.add_argument("--comment", required=True, help="Upload log comment")
    p_upload.add_argument("--text", help="Wikitext for the File: page description (optional)")
    p_upload.add_argument("--force", action="store_true",
                           help="Skip the near-duplicate-filename check")

    p_recent = sub.add_parser("recent", help="List recent changes")
    p_recent.add_argument("--limit", type=int, default=10)

    p_cat = sub.add_parser("category", help="List pages in a category")
    p_cat.add_argument("name")
    p_cat.add_argument("--limit", type=int, default=50)

    args = parser.parse_args()
    wiki = Wiki(load_config())
    wiki.login()

    if args.command == "read":
        wiki.read(args.title)
    elif args.command == "search":
        wiki.search(args.query, args.limit)
    elif args.command == "edit":
        text = resolve_text(args)
        if not args.force:
            check_markdown_or_exit(text)
        wiki.edit(args.title, text, args.summary, append=False)
    elif args.command == "append":
        text = resolve_text(args)
        if not args.force:
            check_markdown_or_exit(text)
        wiki.edit(args.title, text, args.summary, append=True)
    elif args.command == "blog-entry":
        text = resolve_text(args)
        if not args.force:
            check_markdown_or_exit(text)
        wiki.blog_entry(args.title, text, args.summary)
    elif args.command == "upload":
        wiki.upload(args.filename, args.file, args.comment, text=args.text, force=args.force)
    elif args.command == "recent":
        wiki.recent(args.limit)
    elif args.command == "category":
        wiki.category(args.name, args.limit)


if __name__ == "__main__":
    main()
