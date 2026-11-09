# engrams/

Local lookup brain. Deterministic, zero vector DB, pure text math.

Per AfterImage-Engram AGENTS.md:
- Zero dependencies (stdlib Python). If a change needs a package, the change is wrong.
- Verbatim log is store of record. Ghost ledger for evictions. Typed absence is a first-class answer.
- Import afterimage_* — do not reimplement.

Layout mirrors AfterImage:

```
engrams/
  packs/
    core/            # Python, JS/TS, git, shell — pinned
    codetraining/    # user-pinned OSS SRDs (SHA256 manifest)
  index.db           # stemmed inverted index (sqlite, built locally)
  store/             # SessionStore verbatim log (append-only)
```

Packs are registered by the user pointing at local files. Example on this machine:
F:/llmtrainingpipeline/codetraining/ contains C++ Standard Library, Python Standard Library by Example, HTML Standard, OWASP guides, kernel docbooks. Index the ones you own / are public-domain. Never fetch web content at runtime into context.

Verify arithmetic with TI-85 (afterimage ti85.py, AST whitelist). Model answers naturally, claims are machine-checked, one repair round.
