# FRONTIER — agentic SOTA scan (2026-11) and where EHC sits

Standing intel scan for the roadmap. Sources are linked; claims about the field
are theirs, claims about EHC are verified in-repo. The multi-agent swarm and
autonomous-loop lanes are **deliberately out of the core product**: they feed
Mission Control and the premium suites, and are developed in parallel without
blocking core work.

## 1. Interop standards (the stack is settling)

- **MCP** — tools/data layer, now under the Linux Foundation's Agentic AI
  Foundation; went stateless (July 2026), which simplifies hosting.
  [gravity.fast](https://gravity.fast/blog/ai-agent-interop-standards-2026/), [atlan.com](https://atlan.com/know/agent-interoperability-protocols/)
- **A2A** — agent-to-agent task delegation, reached v1.0, same foundation.
  The working consensus: MCP connects agents to tools, A2A connects agents to
  each other. [a2a-protocol.org](https://a2a-protocol.org/latest/topics/a2a-and-mcp/)
- **ACP** (IBM/BeeAI) and **AGNTCY** (discovery, identity, SLIM messaging) —
  the remaining lanes; AGNTCY's own marketing ("three layers, three lanes") is
  disputed by production teams.
  [yoyo.bot comparison](https://yoyo.bot/blog/mcp-vs-a2a-vs-acp-agent-protocols-compared), [futurepicker field note](https://futurepicker.com/en/agent-interoperability-mcp-a2a-agntcy-2026/en/)

**EHC position:** MCP client exists (`src/server/mcp.ts`). Core stays
single-runtime and local-first — no A2A server in the free core (a networked
agent surface is exactly what the security posture exists to avoid). A
Mission Control A2A/agent-card endpoint is the natural premium seam: EHC
windows already behave as addressable workers (session = unit of work, worktree
per window, durable runs per session).

## 2. Multi-agent patterns (what survives production)

- **Orchestrator-worker is the consensus default** for decomposable,
  breadth-first work: a lead agent decomposes, dispatches to fresh workers with
  clean context and narrow scope, runs them in parallel, consolidates
  compressed results. [Anthropic: multi-agent research system](https://www.anthropic.com/research/multi-agent-research-system)
- **Five named patterns** cover production usage: orchestrator/worker,
  pipeline, fan-out, debate, routing. Supervisor/worker ≈ orchestrator/worker;
  "swarm" (peer handoffs, à la OpenAI Swarm) suits short scopes.
  [explainx 2026 guide](https://explainx.ai/blog/multi-agent-orchestration-patterns-guide-2026), [reactify orchestration 2026](https://www.reactify-solutions.com/articles/multi-agent-orchestration-2026)
- **The honest counter-argument stands**: Cognition's single-agent position —
  multi-agent context fragmentation produces confidently wrong answers unless
  task decomposition is forced to be verifiable. Multi-agent is for
  breadth/parallelism, not as a default architecture.
  (linked from the reactify survey above)
- Anthropic's security finding: a long-running coordinating swarm finds
  vulnerabilities at a constant rate vs scoped independent agents — relevant
  to AgentWatch sweep design. [Anthropic: patterns and problems](https://www.anthropic.com/research/multiagent-systems)

**EHC position (parallel lane, Mission Control):**
- **Orchestrator-worker over sessions**: Mission Control as lead agent,
  EHC windows as fresh-context workers (one worktree each — the isolation the
  pattern demands is already structural: 1 task = 1 window = 1 worktree).
- **Fan-out + consolidate** maps onto SOPs: today SOP nodes are sequential with
  human gates; a `parallel` node type (fan-out to N agent nodes, join on
  completion) is the smallest step that captures the pattern while keeping
  human gates. Premium.
- **Debate/verifier pairing**: AgentWatch (`aw`) is already an independent
  reviewer process; pairing a builder window with a reviewer window that can
  send back is EHC-native "debate" without new infrastructure.
- Frameworks (LangGraph/CrewAI/AutoGen/MS Agent Framework) are **not** to be
  imported; EHC's durable run + timeline + resume (0.0.3, `docs/AGENTRUN.md`)
  already implements the durable-orchestration substrate they all converge on.

## 3. Autonomous loops / long-horizon (the real frontier)

- Benchmarks that matter now: **Terminal-Bench 2.1** and **SWE-bench
  Verified**; Codex/GPT-5.5 leads Terminal-Bench at ~83%; Claude Code
  competitive on real-PR work. [benchmarks overview](https://toastyst.github.io/SpaghettiStories/2026/07/01/ai-coding-agents-2026-benchmarks/), [presenc.ai data](https://presenc.ai/research/coding-agent-benchmarks-2026)
- Long-horizon (>100 interdependent steps, multi-day persistence, human
  collaboration) remains **open research** — do not promise it.
  [long-horizon survey](https://2bnr.github.io/agentic-ai-course/sections/16-long-horizon.html), [HORIZON leaderboard](https://horizonbench.org/)
- Every serious deployment converges on the same shape: **loop + tools +
  sandbox + audit**; autonomous coding agents are now ~4% of GitHub commits.
  [reactify production survey](https://www.reactify-solutions.com/articles/ai-coding-agents-production-2026)
- Self-improving loops (agent edits the agent) are a research curiosity, not a
  product feature — and are exactly what the detonation lane exists to contain.
  [arXiv 2504.15228](https://arxiv.org/html/2504.15228)

**EHC position:** the core loop already has the discipline points the field
converged on — bounded steps, budget escalation, context-overflow recovery,
per-turn checkpoints, durable run records, honest failure. The autonomous
(updates-free) mode exists behind SOP `automated` runs only. Extending
autonomy = Mission Control resumes/escalates runs (premium), never a silent
core default. EHC's differentiators vs the field: **local-first engine ladder,
zero-download policy, human gates as first-class, and the detonation lane** —
no mainstream harness ships a real OS-level sandbox for unclean input.

## 4. Concrete parallel-lane backlog (Mission Control / premium)

1. `parallel` SOP node (fan-out/join) — small, testable, reuses run records.
2. Mission Control orchestrator: session fleet view + lead-agent prompt that
   decomposes an objective into per-window tasks (workers = existing windows).
3. Reviewer pairing: builder window ↔ AgentWatch reviewer with send-back.
4. A2A agent-card endpoint (opt-in, loopback-only by default).
5. Evaluator hooks: per-run rubric scoring persisted to the timeline (HORIZON-
   style long-horizon index for your own fleet — dogfood the shape).

None of these block core; all reuse the 0.0.3 run substrate.

## 5. What this means for the current Linux pass

Nothing architectural changes: the frontier validates the existing spine
(durable runs, SOPs, sandbox, audit). The Linux/Omarchy work proceeds as
scoped — packaging, detonation lane, desktop integration — which is exactly
the "loop + tools + sandbox" convergence the field reports, done EHC-style.
