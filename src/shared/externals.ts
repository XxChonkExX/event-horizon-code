// Event Horizon Code - the only public hosts this app may ever send the user
// to, or download from.
//
// Zero telemetry, zero cloud: nothing here is contacted unless the USER acts -
// an install link in the Toolchain Doctor, an optional download in the Sensory
// panel - or configures a BYOK endpoint of their own. The tables below are the
// single source for those links, and every URL is checked against them again
// before use: in main before a link opens, in the server before a download
// starts and on every redirect hop.

/** Official install pages, keyed by the command the Toolchain Doctor probes. */
export const INSTALL_PAGES: Record<string, string> = {
  // Rust
  cargo: "https://rustup.rs/", rustc: "https://rustup.rs/", rustup: "https://rustup.rs/",
  // C / C++ / asm
  clang: "https://releases.llvm.org/download.html", gcc: "https://gcc.gnu.org/", "as": "https://www.gnu.org/software/binutils/",
  "nasm": "https://www.nasm.us/", cmake: "https://cmake.org/download/", "asm-lsp": "https://github.com/bergerprinter/asm-lsp",
  // Ruby
  ruby: "https://www.ruby-lang.org/en/documentation/installation/", gem: "https://www.ruby-lang.org/en/documentation/installation/",
  bundle: "https://bundler.io/",
  // PHP / Composer
  composer: "https://getcomposer.org/download/",
  // JavaScript / TypeScript
  node: "https://nodejs.org/en/download", npm: "https://nodejs.org/en/download",
  deno: "https://docs.deno.com/runtime/getting_started/installation/", bun: "https://bun.sh/docs/installation",
  buf: "https://github.com/bufbuild/buf/releases", protoc: "https://github.com/protocolbuffers/protobuf/releases",
  "graphql-lsp": "https://github.com/graphql/graphiql/tree/main/packages/graphql-language-service-server",
  // Python
  python: "https://www.python.org/downloads/", python3: "https://www.python.org/downloads/", py: "https://www.python.org/downloads/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  // Go, Zig, Swift, Kotlin, Dart
  go: "https://go.dev/doc/install", zig: "https://ziglang.org/download/", swift: "https://www.swift.org/install/",
  kotlin: "https://kotlinlang.org/docs/command-line.html", dart: "https://dart.dev/get-dart", flutter: "https://docs.flutter.dev/get-started/install",
  // JVM
  java: "https://adoptium.net/installation/", javac: "https://adoptium.net/installation/",
  mvn: "https://maven.apache.org/install.html", gradle: "https://gradle.org/install/", sbt: "https://www.scala-sbt.org/1.x/docs/Setup.html", scala: "https://www.scala-lang.org/download/",
  // .NET, PHP, Perl, Lua, Julia, R
  dotnet: "https://dotnet.microsoft.com/download", php: "https://www.php.net/downloads.php", perl: "https://www.perl.org/get.html",
  lua: "https://www.lua.org/download.html", luajit: "https://luajit.org/download.html", julia: "https://julialang.org/downloads/", r: "https://www.r-project.org/",
  // Functional
  clj: "https://clojure.org/guides/install_clojure", clojure: "https://clojure.org/guides/install_clojure", "clojure-lsp": "https://clojure-lsp.io/installation/",
  elixir: "https://elixir-lang.org/install.html", erl: "https://www.erlang.org/downloads",
  cabal: "https://www.haskell.org/ghcup/", ghc: "https://www.haskell.org/ghcup/", stack: "https://www.haskellstack.org/",
  "haskell-language-server-wrapper": "https://www.haskell.org/ghcup/",
  ocaml: "https://ocaml.org/install", opam: "https://ocaml.org/install", ocamllsp: "https://ocaml.org/install",
  // Nim, Nix
  nim: "https://nim-lang.org/install.html", nimlsp: "https://github.com/PMunch/nimlsp", nix: "https://nixos.org/download/",
  // Data / infra
  docker: "https://docs.docker.com/get-started/get-docker/", hadolint: "https://github.com/hadolint/hadolint/releases",
  terraform: "https://developer.hashicorp.com/terraform/downloads", "terraform-ls": "https://github.com/hashicorp/terraform-ls",
  psql: "https://www.postgresql.org/download/", sqlite3: "https://www.sqlite.org/download.html", sqls: "https://github.com/sqls-server/sqls",
  // Shells
  bash: "https://git-scm.com/downloads",
};

/** Footnotes shown on Windows, where "install it" has a second half. */
export const INSTALL_NOTES: Record<string, string> = {
  rustc: "On Windows, Rust also needs the Visual Studio C++ Build Tools.",
  cargo: "On Windows, Rust also needs the Visual Studio C++ Build Tools.",
  clang: "On Windows the simplest route is MSYS2 or the Visual Studio Build Tools.",
  gcc: "On Windows the simplest route is MSYS2 (mingw-w64).",
  ruby: "On Windows use RubyInstaller.",
  bash: "On Windows, bash comes with Git for Windows (Git Bash).",
};

const DOWNLOAD_REDIRECT_SUFFIXES = [".githubusercontent.com", ".huggingface.co", ".hf.co"];
const HOSTS = new Set([...Object.values(INSTALL_PAGES), "https://github.com", "https://huggingface.co"].map((u) => new URL(u).hostname));

function parse(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u : null;
  } catch { return null; }
}
const onHost = (h: string): boolean => [...HOSTS].some((a) => h === a || h.endsWith("." + a));

/** The normalized URL if it is https and on an allowed host - else null. */
export function allowedExternalUrl(raw: string): string | null {
  const u = parse(raw);
  return u && onHost(u.hostname.toLowerCase()) ? u.href : null;
}

/** Same check for a download's redirect hops, which CDN hosts may serve. */
export function allowedDownloadHop(raw: string): string | null {
  const u = parse(raw);
  if (!u) return null;
  const h = u.hostname.toLowerCase();
  return onHost(h) || DOWNLOAD_REDIRECT_SUFFIXES.some((s) => h.endsWith(s)) ? u.href : null;
}
