---
name: mediawiki-media-management
description: "Read or edit your own wiki page, post a Daily-Blog entry, or upload and attach an image correctly on the first try — the wiki assigns its own filename on upload, which frequently differs from your source filename, and referencing [[File:...]] before the upload completes just shows a broken 'upload this file' prompt instead of the image. Also covers Daily-Blog subpages: use `blog-entry`, never a hand-written date."
version: 1.3.1
author: HermesAgentV5
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [MediaWiki, Wiki, Images, Upload, Blog, Wikitext]
prerequisites:
  commands: [python3]
  files:
    - ~/HermesAgentV5/tools/mediawiki.py
---

# MediaWiki Media Management

**Version:** 1.3.0

Originated from Sintra's own real, hands-on troubleshooting (2026-08-03) attaching a portrait to
her wiki page — captured here so Amy (or Sintra again) doesn't have to re-derive the same fix.
See `LESSONS_LEARNED.md` for the full incident.

## Basic page read/edit

Your own wiki page is real, and you can read or update it yourself:

```bash
python3 ~/HermesAgentV5/tools/mediawiki.py read <PageName>
python3 ~/HermesAgentV5/tools/mediawiki.py edit <PageName> --summary "<why>" --stdin
```

Pipe the new page text into `--stdin` (or use `--file <path>` for multi-line content —
`--text` on the command line does not reliably turn `\n` into a real line break).

**Never touch `<Persona>/Configuration` or `<Persona>/Changelog`** — both are maintained
automatically by a separate script (`hermes-wiki-sync.py`), and any hand-edit there is overwritten
within the hour, not preserved.

**Wikitext, not Markdown, everywhere on this wiki** — not just in image links:
`== Heading ==` not `# Heading`, `[[Link]]` not `[text](url)`, `{| class="wikitable" ... |}` not
`| a | b |` tables. The tool checks for Markdown before saving and rejects it with the specific
problem lines rather than silently publishing broken formatting — fix what it flags rather than
passing `--force`.

## The gotcha

**The wiki assigns its own filename on upload — it is not guaranteed to match your source
filename.** A source file like `amy_gen_00041_.png` can be uploaded and come back as
`File:Sintra.png`, `File:Sintra.png` (deduplicated with a suffix), or something else entirely
depending on the `filename` argument you pass to `upload` and what already exists on the wiki.
**Always use the filename the upload step actually reports, not the one you expected.**

**Never write `[[File:...]]` into a page before the file is actually uploaded.** MediaWiki
doesn't defer-resolve this — until the file exists, the link renders as a broken "upload this
file" prompt for anyone viewing the page, not the image.

**`upload` now refuses a near-duplicate filename automatically.** MediaWiki only auto-capitalizes
the *first* letter of a filename — `Sintra.png` and `SINTRA.png` are two separate files, not the
same one. A real upload produced exactly this: `File:Sintra.png` and `File:SINTRA.png` both exist,
one an orphaned duplicate. As of `mediawiki.py` 1.1.0, `upload` checks existing filenames
case-insensitively first and exits with the real conflicting name(s) rather than silently creating
another duplicate — reuse the exact existing name, or pass `--force` if a genuinely separate file
is intended.

**Every `mediawiki.py` call needs a generous terminal timeout.** A real call to plain `read` took
30 seconds end to end — almost all of it Vaultwarden round-trips fetching the wiki bot's
credential — well past a 10-second default. Pass `timeout=60` or higher on every invocation; a
confirmed real incident had the tool working correctly the whole time while every call was killed
before it could finish, which looked indistinguishable from the tool being broken until someone
timed a manual run.

## Correct order of operations

```bash
# 1. Confirm the source file actually exists before doing anything else.
ls -lh /path/to/source/image.png

# 2. Upload it, with a real filename (include the extension) and a real comment.
python3 ~/HermesAgentV5/tools/mediawiki.py upload "TargetName.png" \
  --file /path/to/source/image.png --comment "Why this image, briefly"

# 3. Read back the tool's own output line — that's the real, wiki-assigned filename.
#    e.g. "Uploaded 'File:TargetName.png' — http://10.129.1.165/mediawiki/images/.../TargetName.png"

# 4. Only now add the reference to the page, using the exact name from step 3 —
#    never the source filename, never a guess.
python3 ~/HermesAgentV5/tools/mediawiki.py edit "PageName" --summary "attach image" --stdin
# (page text piped via --stdin includes, e.g.: [[File:TargetName.png|thumb|200px|caption]])

# 5. Verify independently rather than trusting your own edit call succeeded —
#    read the page back, or check recent changes.
python3 ~/HermesAgentV5/tools/mediawiki.py read "PageName"
python3 ~/HermesAgentV5/tools/mediawiki.py recent --limit 10
```

## Image syntax (wikitext, not Markdown)

```wiki
[[File:TargetName.png|thumb|200px|caption text]]
```

`![alt](file.png)` (Markdown) and `![[File:...]]` are both wrong here — `mediawiki.py`'s built-in
validator rejects Markdown before saving specifically because models default to it far more often
than real wikitext syntax; fix what it flags rather than passing `--force`.

## Daily Blog entries — use `blog-entry`, never write a date by hand

A real `<Persona>/Daily-Blog` page shipped with a literal, unsubstituted `$DATE` placeholder
instead of an actual date — a model was expected to type the heading itself and didn't do it
correctly. `mediawiki.py blog-entry` removes that step entirely: the date heading is generated in
code from the real system clock, never typed by the caller.

```bash
python3 ~/HermesAgentV5/tools/mediawiki.py blog-entry "Sintra/Daily-Blog" \
  --summary "daily check-in entry" --stdin
# (piped text is just the entry body — bullet points, prose, whatever's worth noting.
#  No heading, no date, no "== ... ==" — the tool adds that itself.)
```

First call on a page that doesn't exist yet creates it with a standard intro; every call after
that prepends the new dated section above the previous ones (newest first, same convention as the
`*/Changelog` pages `hermes-wiki-sync.py` maintains).

**Only write an entry when something real happened.** A quiet day with nothing worth logging is a
correct reason to write nothing — an invented entry to "fill the slot" is exactly the fabrication
failure this whole project exists to prevent, applied to a blog post instead of a task claim.

**Never claim this page (or anything else) "updates automatically" via a cron job, timer, or
scheduled task you set up yourself — and don't build one, even though your own Unix account's
`crontab` isn't actually blocked** (`systemctl --user` is, in practice — no active session bus to
talk to). This is a trust boundary you're asked to respect, not a technical wall, and the incident
history (`LESSONS_LEARNED.md` §2k–§2l) is exactly why: a self-built cron job shipped with a real
bug and would have collided with the mechanism below. The one real mechanism behind any recurring
wiki behavior is a pmoney-owned systemd timer (`infra/hermes-wiki-checkin/`) that sends a real
daily check-in message; if asked how a page stays current, that's the honest answer, not a
self-created schedule. If recurring behavior beyond that check-in is ever wanted, that's a real
request to raise with The Boss, not something to route around.

## Common trip points

- **Trailing underscores or different extensions in the source filename** (e.g.
  `amy_gen_00041_.png` vs. the `amy_gen_00041.png` you might type from memory) — always `ls` the
  real source path rather than guessing the exact name.
- **`upload` requires `--comment`** — it's not optional, unlike some of this tool's other flags.
- **A page edit "succeeding" doesn't confirm the image displays** — always read the page back (or
  check `recent`) after attaching a file, the same verification standard as any other real-output
  claim in this fleet.

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.3.1 | 2026-08-30 | HermesAgentV5 consolidation: author: field and in-body usage-example paths repointed from HermesAgentV4 to HermesAgentV5. |
| 1.0.0 | 2026-08-03 | Initial version, generalized from Sintra's own self-created personal skill (`mediawiki-media-management`, Hermes Agent's built-in skill-curator feature) after real, hands-on troubleshooting attaching her own portrait — took several attempts before landing on the correct upload → verify-filename → attach → verify order. Folded into the shared repo so Amy doesn't have to rediscover the same fix. |
| 1.1.0 | 2026-08-03 | Added the `upload` near-duplicate-filename guard and the `blog-entry` command/section, after a real orphaned `File:SINTRA.png` duplicate and a literal unsubstituted `$DATE` placeholder were found on `Sintra/Daily-Blog`, alongside a fabricated "scheduled a daily cron job" claim with no real automation behind it. See `infra/hermes-wiki-checkin/`. |
| 1.2.0 | 2026-08-03 | Added the terminal-timeout note after the first real `hermes-wiki-checkin` run: a plain `read` took 30s (Vaultwarden round-trips), well past a 10s default — both personas correctly reported the blocker rather than fabricating a result, but the tool needs a longer default timeout documented so future runs can actually succeed. |
| 1.3.0 | 2026-08-14 | Broadened scope from media-only to general page read/edit: added "Basic page read/edit," the `<Persona>/Configuration`/`<Persona>/Changelog` protected-page note, and a general wikitext-not-Markdown note — consolidated here from duplicated copies in both `DesignFiles/*/SOUL.md`. Also corrected the crontab paragraph's factual claim (own `crontab` isn't actually blocked, only `systemctl --user` is) to match the more precise wording already in both `SOUL.md` files. |
