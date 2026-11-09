---
name: ruby-bundler
description: Ruby development help. Use when the user asks about Ruby code, builds, or errors.
license: MIT
---

# Ruby

Use this skill for Ruby work in Event Horizon Code.

## Process

1. Resolve language pack via languages/ruby/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: ruby -v, bundle -v, gem -v
- LSP: ruby-lsp
- Build/Test/Run: bundle install / bundle exec rake test / ruby {file}

## References

- engramPack: ruby
- Tier: 1
