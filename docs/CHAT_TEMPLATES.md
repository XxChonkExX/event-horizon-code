# Chat templates — correct prompting + tool calling per model family

Event Horizon Code vendors the canonical Jinja chat templates for the major model
families in `resources/templates/`. They are taken verbatim from llama.cpp's
`models/templates` directory (MIT, ggml-org/llama.cpp), which in turn mirrors the
template each model's authors publish. We reuse, attribute, and only hand-roll
what nobody already solved.

## Why this exists

A GGUF carries an embedded chat template. Many community re-uploads
(abliterated, fine-tuned, merged) **strip the tool-calling blocks** from it.
Without those blocks llama-server reports:

```json
"chat_template_caps": { "supports_tools": false, "supports_tool_calls": false }
```

and the model then *narrates* actions ("Running ls...") instead of emitting real
`tool_calls`. The agent loop never executes anything, and the answer is a guess.

This was found the hard way: the engine lane answered chat fine, but a
"list the files" prompt hallucinated a file count with `toolSteps: 0`. The fix
is to hand llama-server a canonical template with `--chat-template-file`.

## What the harness does

- `engine.chatTemplate` in `.harness/config.json` selects the template.
  - `"auto"` (default) detects the family from the model file name and passes
    the matching canonical file.
  - A family id (`"qwen3"`, `"deepseek-v4"`, `"glm-4.7"`, `"granite-4.1"`, ...),
    a bare file name, or an explicit path also work.
- The start response reports what was chosen:
  `engine starting (pid ...) - model x.gguf [template qwen3] - log ...`
- `GET /api/engine/templates?model=<name>` returns the catalog, the detected
  family, and the resolved file - this powers the engine picker UI.
- After start, `/props` on the engine reports `chat_template_caps`. If
  `supports_tools` is false for a family we do not cover, say so plainly
  instead of letting the agent hallucinate tools.

## Covered families (detection is ordered, most specific first)

| Family | Template file | Tools |
|---|---|---|
| qwen3-coder | Qwen3-Coder.jinja | yes |
| qwen3.5 | Qwen3.5-4B.jinja | yes |
| qwen3 / qwq / qwen2.5 / qwen2 | Qwen-*.jinja | yes |
| deepseek v4 / v3.2 / v3.1 / r1 / generic | deepseek-ai-*.jinja | yes |
| glm-4.7 / glm-4.6 / glm | GLM-4.x.jinja | yes |
| granite 4.1 / 4.0 / 3.x | ibm-granite-*.jinja | yes |
| gemma4 | google-gemma-4-31B-it.jinja | yes |
| gemma2 | google-gemma-2-2b-it.jinja | no (base has no tool blocks) |
| llama3.3 / llama3 | meta-llama-Llama-3*.jinja | yes |
| mistral / nemo / ministral / devstral | Mistral*.jinja | yes |
| gpt-oss | openai-gpt-oss-120b.jinja | yes |
| kimi k3 / k2 / thinking | Kimi-*.jinja | yes |
| command-r / cohere | CohereForAI-*.jinja | yes |
| minimax m1-m3 | MiniMax-*.jinja | yes |
| nemotron | NVIDIA-Nemotron-*.jinja | yes |
| seed-oss | ByteDance-Seed-OSS.jinja | yes |
| hermes | NousResearch-Hermes-*.jinja | yes |
| functionary | meetkai-functionary-*.jinja | yes |
| plus: phi, smollm, lfm2, hunyuan, solar, stepfun, reka, gigachat, mimo, minicpm, apriel, laguna, spark, bielik, apertus, rwkv | | |

53 family rules map onto 69 vendored files, so community fine-tunes
(`huihui-qwen3-4b-abliterated-v2`, ...) inherit the correct template from their
base family name.

## DeepSeek coder features (borrowed, with attribution)

- **FIM / infill**: `POST /api/engine/infill` proxies the engine's `/infill`
  endpoint (`input_prefix` / `input_suffix`), and the `code_complete` tool lets
  the agent fill-in-the-middle. Enable `engine.spmInfill` for models that prefer
  Suffix/Prefix/Middle token order (typical for DeepSeek-Coder style models).
- **Reasoning stream**: `reasoning_content` (OpenAI-compatible lane) and
  `thinking` (Ollama lane) are captured separately from the answer, so a
  reasoning model's chain of thought never leaks into the reply and never eats
  the answer budget silently - the loop escalates the budget once, then reports.
- **Coder persona**: `params.agent = "coder"` switches the system prompt to a
  read-first / minimal-diff / verify-after-edit discipline (see docs/AGENTS.md).
- **Tool-call plumbing**: our internal tool calls are normalised to the OpenAI
  wire shape (`{id, type, function:{name, arguments}}`) for both lanes; the
  internal shape is what llama-server rejects with
  "Missing tool call type".

## Verification log (what was actually tested)

- Engine + `huihui-qwen3-4b-abliterated-v2-q8_0.gguf`, template `auto` -> qwen3:
  `supports_tools: true`, real `ls` tool call returned.
- Full agent loop through `/api/acp/session/prompt`: `toolSteps: 1`, tool
  executed, result fed back, and the model answered "22 entries" from real tool
  output (previously it hallucinated).
- `verify` tool: detected `package.json` + `package-lock.json` -> `npm test`.
- `code_complete` tool: engine `/infill` round trip.

## Attribution

Templates: llama.cpp, MIT License, ggml-org/llama.cpp. Each template is the
work of its model family's authors (Qwen - Apache-2.0, DeepSeek - MIT,
Gemma - Google/Gemma Terms, GLM - Z.ai, Granite - Apache-2.0, Llama - Meta
Llama license, Mistral - Apache-2.0, ...). Files are redistributed here with
this notice; model weights are never shipped.
