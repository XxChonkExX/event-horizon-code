# Engram Integration

Per AGENTS.md in AfterImage-Engram (XxChonkExX/AfterImage-Engram):

1. Zero runtime dependencies for the library. Stdlib Python 3.10+ only.
2. Pure functions in library core. I/O lives in examples / server glue only.
3. Do not reimplement. Import afterimage_* modules. A private copy is a bug.
4. Never edit frozen artifacts. New data = new files.
5. Byte discipline: LF pinned. If git shows modified files on fresh clone, renormalize and report.

## How Event Horizon uses it

- `engrams/` mirrors AfterImage store layout: verbatim log (store of record), stemmed inverted index, ghost ledger, typed absence.
- Tools exposed to agent:
  - engram_search(query, top_k) -> records with provenance, or certified absence (typed)
  - engram_register(path, pack_name) -> index a user-pinned PDF/MD/SRD locally
  - calc_verify(expr) -> TI-85 AST-whitelist scientific calculator, no eval()
  - skill_load(name) -> progressive disclosure of Agent Skills
- Verification router pattern from AfterImage examples/afterimage_router.py: model answers naturally, calc sweep verifies arithmetic claims, one repair round, no retraining.

## Corpus

Indexed from local files only. Initial detection:

- F:/llmtrainingpipeline/codetraining/ (C++ Standard Library, Python Standard Library by Example, HTML Standard, OWASP, kernel docs, SQL:1999, DB-Library C ref, etc.)
- User packs under engrams/packs/<name>/ with SHA256 manifest.

No downloading copyrighted texts. Only open-source / user-owned / public-domain sources. Cold storage G:/New folder is for overflow packs, not live index.

## Measured results (AfterImage)

- Recall 86% home scenario, 90% transfer on new domain with lessons.
- Fabrication floor 73-100% on absent content for small models without typed absence. Engram guarantees delivery and honest absence detection. It does not cure confabulation alone. Training objective pairs with it.
