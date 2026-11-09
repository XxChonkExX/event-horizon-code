# engrams/packs/

Local pinned reference packs. No web fetch at runtime. User registers their own files.

Structure per pack:
- `manifest.json` — name, version, SHA256 list, source license
- `*.md` — SRD or library reference text, indexed by AfterImage (stemmed inverted index)
- `records.jsonl` — verbatim records for SessionStore (append-only)

Seeded locally from F:/llmtrainingpipeline/codetraining/ (C++ Standard Library, Python Standard Library by Example, HTML Standard, OWASP guides, kernel docs). Copy or reference by absolute path; do not commit copyrighted PDFs to git.

Per AfterImage AGENTS.md: zero runtime dependencies, pure functions, import afterimage_* — do not reimplement, never edit frozen artifacts (new data = new files), LF byte discipline.
