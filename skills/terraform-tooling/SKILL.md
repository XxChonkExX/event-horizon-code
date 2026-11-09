---
name: terraform-tooling
description: Terraform / HCL development help. Use when the user asks about Terraform / HCL code, builds, or errors.
license: MIT
---

# Terraform / HCL

Use this skill for Terraform / HCL work in Event Horizon Code.

## Process

1. Resolve language pack via languages/terraform/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: terraform version, terraform-ls --version
- LSP: terraform-ls serve
- Build/Test/Run: terraform init / terraform validate / terraform plan

## References

- engramPack: terraform
- Tier: 2
