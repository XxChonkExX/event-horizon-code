---
name: php-composer
description: PHP development help. Use when the user asks about PHP code, builds, or errors.
license: MIT
---

# PHP

Use this skill for PHP work in Event Horizon Code.

## Process

1. Resolve language pack via languages/php/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: php -v, composer --version
- LSP: intelephense --stdio
- Build/Test/Run: composer install / php vendor/bin/phpunit / php -S localhost:8000 -t public

## References

- engramPack: php
- Tier: 1
