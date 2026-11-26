// Event Horizon Code - pinned catalog for the OPTIONAL Sensory downloads.
// GENERATED from the sources' own metadata (scripts/generate-sensory-catalog.mjs);
// do not edit by hand. Each row: official URL, exact size, published SHA-256.
// A file that does not match its pin is deleted, never installed.

import type { CatalogItem } from "./sensoryfetch";

const HF = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";
const WHISPER = "https://github.com/ggml-org/whisper.cpp/releases/download/b5907/";
// The release the engine rows are pinned to (kept in sync with WHISPER).
export const WHISPER_RELEASE_URL = "https://github.com/ggml-org/whisper.cpp/releases/tag/b5907";

export const SENSORY_CATALOG: CatalogItem[] = [
  { id: "whisper-win-x64", kind: "engine", label: "whisper.cpp for Windows x64", note: "Official CPU build. Installs whisper-cli and its runtime DLLs; nothing else from the archive is kept.", file: "whisper-cli.exe", platform: "win32", zip: true, keep: /^(whisper-cli\.exe|whisper\.dll|ggml.*\.dll|llama\.dll)$/,
    url: WHISPER + "whisper-bin-x64.zip", size: 9168428, sha256: "ecca07b277d943e9b9f4712856a144b857271a6b333104e511e1988e80db582b" },
  { id: "whisper-win-arm64", kind: "engine", label: "whisper.cpp for Windows ARM64", note: "Official CPU build. Installs whisper-cli and its runtime DLLs; nothing else from the archive is kept.", file: "whisper-cli.exe", platform: "win32", zip: true, keep: /^(whisper-cli\.exe|whisper\.dll|ggml.*\.dll|llama\.dll)$/,
    url: WHISPER + "whisper-bin-win-cpu-arm64.zip", size: 4379517, sha256: "4e522946827dcbc517d3cd7ee8d6cfe760e8143076924ac8513622694aa3ccfd" },
  { id: "whisper-linux-x64", kind: "engine", label: "whisper.cpp for Linux x64", note: "Official CPU build (Ubuntu; runs on most glibc distributions). Installs whisper-cli and its libraries; nothing else from the archive is kept.", file: "whisper-cli", platform: "linux", tarGz: true, keep: /^(whisper-cli|lib.*\.so.*)$/,
    url: WHISPER + "whisper-bin-ubuntu-x64.tar.gz", size: 10413708, sha256: "a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd" },
  { id: "tiny.en", kind: "model", label: "Tiny - English", note: "Fastest; rough.", file: "ggml-tiny.en.bin", langs: "en",
    url: HF + "ggml-tiny.en.bin", size: 77704715, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f" },
  { id: "base.en", kind: "model", label: "Base - English", note: "Quick; fine for short commands.", file: "ggml-base.en.bin", langs: "en",
    url: HF + "ggml-base.en.bin", size: 147964211, sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
  { id: "small.en", kind: "model", label: "Small - English", note: "Recommended for English: noticeably more accurate, still about 5x faster than real time on a CPU.", file: "ggml-small.en.bin", langs: "en",
    url: HF + "ggml-small.en.bin", size: 487614201, sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d" },
  { id: "medium.en", kind: "model", label: "Medium - English", note: "Most accurate English; slower on a CPU.", file: "ggml-medium.en.bin", langs: "en",
    url: HF + "ggml-medium.en.bin", size: 1533774781, sha256: "cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356" },
  { id: "tiny", kind: "model", label: "Tiny - multilingual", note: "~100 languages; rough.", file: "ggml-tiny.bin", langs: "multi",
    url: HF + "ggml-tiny.bin", size: 77691713, sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21" },
  { id: "base", kind: "model", label: "Base - multilingual", note: "~100 languages.", file: "ggml-base.bin", langs: "multi",
    url: HF + "ggml-base.bin", size: 147951465, sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe" },
  { id: "small", kind: "model", label: "Small - multilingual", note: "Recommended for languages other than English.", file: "ggml-small.bin", langs: "multi",
    url: HF + "ggml-small.bin", size: 487601967, sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b" },
  { id: "large-v3-turbo", kind: "model", label: "Large v3 Turbo - multilingual", note: "Best accuracy across ~100 languages; needs a strong machine.", file: "ggml-large-v3-turbo.bin", langs: "multi",
    url: HF + "ggml-large-v3-turbo.bin", size: 1624555275, sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69" },
];
