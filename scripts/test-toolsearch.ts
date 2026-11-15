// Tool-search tests: toolset splitting, relevance ranking, on-demand loading,
// and MCP tool dispatch through runTool. Run: npm run toolsearch:test

import { splitToolset, searchTools, CORE_TOOL_NAMES, TOOL_SEARCH_SPEC } from "../src/server/toolSearch";
import { runTool } from "../src/server/tools";
import { TOOL_SPECS } from "../src/server/agentTools";
import type { ToolDef } from "../src/server/agentTools";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`); }
}

function fakeTool(name: string, description: string): ToolDef {
  return { type: "function", function: { name, description, parameters: { type: "object", properties: {} } } };
}

function bigToolset(n: number): ToolDef[] {
  const out: ToolDef[] = [];
  const topics = ["screenshot", "browser_click", "db_query", "email_send", "calendar_create", "pdf_extract", "image_resize", "csv_parse", "git_blame", "docker_ps"];
  for (let i = 0; i < n; i++) {
    const topic = topics[i % topics.length];
    out.push(fakeTool(`mcp_fake_${topic}_${i}`, `Use this tool to ${topic.replace("_", " ")} on demand. Fake tool ${i}.`));
  }
  return out;
}

async function main(): Promise<void> {
  console.log("[ehc] tool search tests");

  // 1. small toolset: everything advertised, no search handle
  const small = [...Array.from({ length: 10 }, (_, i) => fakeTool(`mcp_fake_tool_${i}`, `fake tool ${i}`))];
  const a = splitToolset(small);
  check("small toolset advertises everything", a.advertised.length === small.length && a.deferred.length === 0 && a.search === false);

  // 2. large toolset (built-ins + 40 fake MCP tools, as the agent loop builds it):
  // core + tool_search advertised, rest deferred
  const all: ToolDef[] = [...TOOL_SPECS, ...bigToolset(40)];
  const b = splitToolset(all);
  check("large toolset splits", b.search === true && b.deferred.length === all.length - b.advertised.length + 1);
  const advertisedNames = new Set(b.advertised.map((t) => t.function.name));
  check("tool_search is advertised", advertisedNames.has("tool_search"));
  check("core tools are advertised", Array.from(CORE_TOOL_NAMES).every((n) => advertisedNames.has(n)));
  check("deferred tools are NOT advertised", !advertisedNames.has("mcp_fake_screenshot_0"));
  check("nothing lost in the split", b.advertised.length + b.deferred.length === all.length + 1); // +1 is tool_search

  // 3. relevance ranking: the right tool ranks first
  const hits = searchTools("take a screenshot of the screen", all, 6);
  check("screenshot query finds screenshot tool", hits.length > 0 && hits[0].name.includes("screenshot"), JSON.stringify(hits.slice(0, 2).map((h) => h.name)));
  const dbHits = searchTools("query the database", all, 6);
  check("db query finds db tool", dbHits.length > 0 && dbHits[0].name.includes("db_query"), JSON.stringify(dbHits.slice(0, 2).map((h) => h.name)));
  check("nonsense query returns nothing", searchTools("zzqqxx wobble", all, 6).length === 0);
  check("empty query returns nothing", searchTools("", all, 6).length === 0);
  check("search never returns itself", searchTools("search for tools", all, 6).every((h) => h.name !== "tool_search"));

  // 4. on-demand loading: matched tools join the advertised set
  const loaded = splitToolset(all);
  const match = searchTools("screenshot", all, 6)[0];
  const def = all.find((t) => t.function.name === match!.name)!;
  loaded.advertised.push(def);
  check("matched tool loadable into advertised set", loaded.advertised.some((t) => t.function.name === match!.name));

  // 5. the search spec itself is well-formed (model-facing schema)
  check("tool_search spec has a query parameter", JSON.stringify(TOOL_SEARCH_SPEC.function.parameters).includes("query"));

  // 6. MCP tools dispatch through runTool (no more "unknown tool" for mcp_*)
  const mcp = await runTool("mcp_nosuch_server_tool", {}, process.cwd());
  check("mcp names route to the mcp client, not 'unknown tool'",
    mcp.ok === false && !/unknown tool/i.test(mcp.error ?? ""), mcp.error ?? "");

  console.log(failures === 0 ? "[ehc] tool search tests: ALL PASS" : `[ehc] tool search tests: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[ehc] tool search tests crashed:", e); process.exit(1); });
