// Event Horizon Code — Terminal placeholder (xterm)
// One terminal per worktree. Per-worktree env (PATH, VIRTUAL_ENV, CARGO_TARGET_DIR).
// Host mode default. Detonate mode routes to sbx microVM.

export default function Terminal({ worktree }: { worktree: string }) {
  return (
    <div class="terminal-body">
      <header>Terminal — {worktree}</header>
      <p>xterm mounts here. Commands run in per-worktree env. LSP/DAP attach per pack.</p>
      <p>Detonate worktrees: commands run inside sbx microVM (--network off). No host credential access.</p>
    </div>
  );
}
