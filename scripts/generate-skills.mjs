// Generate stub skills from languages/*/language.json
// Zero deps. Adds missing skills under skills/<skill>/SKILL.md
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const langDir = path.join(root, "languages");
const skillsDir = path.join(root, "skills");

for (const entry of fs.readdirSync(langDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packFile = path.join(langDir, entry.name, "language.json");
  if (!fs.existsSync(packFile)) continue;
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8"));
  const skillName = pack.skill;
  if (!skillName) continue;
  const dir = path.join(skillsDir, skillName);
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) continue;
  fs.mkdirSync(dir, { recursive: true });
  const md = `---
name: ${skillName}
description: ${pack.displayName} development help. Use when the user asks about ${pack.displayName} code, builds, or errors.
license: MIT
---

# ${pack.displayName}

Use this skill for ${pack.displayName} work in Event Horizon Code.

## Process

1. Resolve language pack via languages/${pack.id}/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: ${pack.toolchain?.check?.join(", ") ?? "see pack"}
- LSP: ${pack.lsp?.command?.join(" ") ?? "-"}
- Build/Test/Run: ${pack.commands?.build ?? ""} / ${pack.commands?.test ?? ""} / ${pack.commands?.run ?? ""}

## References

- engramPack: ${pack.engramPack}
- Tier: ${pack.tier}
`;
  fs.writeFileSync(file, md);
  console.log(`[skills] created ${skillName}`);
}
