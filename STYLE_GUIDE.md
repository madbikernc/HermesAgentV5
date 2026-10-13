# Firmament Style Guide — STE100-lite

**Version:** 1.0.0

**Scope:** every summarization task and every outbound email communication, fleet-wide. This covers
prose a model writes for a human to read — digests, synthesized answers, log briefs, presenter
restyling, and email bodies. It does not cover code, routing decisions, or structured/technical output
that passes through unstyled (`firmament-fleet-target-architecture.md` §6.3's passthrough-by-default).

## The rule

Write in plain, controlled language — roughly 80% of the ASD-STE100 (Simplified Technical English)
discipline, not the full certified standard with its approved-word dictionary:

- **Short, declarative sentences.** Say one thing, then stop.
- **One action or idea per sentence.** Split a compound sentence joined by "and"/"which"/"while" into
  separate sentences when each half is its own fact.
- **Active voice.** "The firewall blocked the request," not "The request was blocked by the firewall."
- **Consistent terminology.** Use the same word for the same thing every time a reply or email refers
  to it. Never swap in a synonym for variety.
- **Plain, common vocabulary.** Prefer the ordinary word over the rare or technical one when both mean
  the same thing. Keep domain terms exact — citation labels, hostnames, error names, model names. This
  rule governs the connective prose around them, not the facts themselves.

This is a register, not a content rule. It never overrides a prompt's own constraints — citation
discipline, the anti-fabrication/anti-injection guards, "never invent certainty," "escalate failures
verbatim," or any instruction to output a fixed sentinel such as `NO_ANSWER_FOUND`. Where the two
conflict, the existing constraint wins; this rule only shapes the sentences that are already correct.

## Where this applies today

| File | Prompt | Output |
|---|---|---|
| `tools/hermes-presenter.py` | `STYLE_SYSTEM_PROMPT` | Outbound Matrix chat restyling |
| `tools/hermes-news-digest.py` | `summarize_highlights()`'s system prompt | Daily per-topic digest email |
| `tools/hermes-news-digest.py` | `condense_weekly()`'s system prompt | Weekly digest email |
| `tools/hermes-retrieve.py` | `SYNTHESIS_SYSTEM_PROMPT` | RAG answer synthesis |
| `tools/hermes-websearch.py` | `SYNTHESIS_SYSTEM_PROMPT` | Web search answer synthesis |
| `tools/hermes-logs.py` | `SOURCE_SYSTEM_PROMPT` | Log/security brief |

A new summarization- or email-composing prompt joins this table in the same change that adds it, so
this table never drifts from the real prompt inventory (`LESSONS_LEARNED.md` §6, rule 2).

## Revision History

| Version | Date | Change |
|---|---|---|
| 1.0.0 | 2026-10-13 | Initial version. Direct operator request: a base instruction, applied fleet-wide, for all summarization tasks and email communications, at roughly 80% of the ASD-STE100 standard. |
