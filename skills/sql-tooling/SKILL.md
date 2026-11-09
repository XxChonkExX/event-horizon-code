---
name: sql-tooling
description: SQL development help. Use when the user asks about SQL code, builds, or errors.
license: MIT
---

# SQL

Use this skill for SQL work in Event Horizon Code.

## Process

1. Resolve language pack via languages/sql/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: sqls --version, sqlite3 --version, psql --version
- LSP: sqls
- Build/Test/Run: sqlite3 db.sqlite < schema.sql / sqlfluff lint / sqlite3 db.sqlite

## References

- engramPack: sql
- Tier: 2
