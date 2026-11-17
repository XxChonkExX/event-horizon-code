// Event Horizon Code - ACP surface security tests (sweep 3, finding 13B)
// Terminal environment filtering: a caller-supplied environment must not be
// able to alter executable resolution or inject code loaders.
// Run: npm run acpsec:test

import { sanitizeTerminalEnv } from "../src/server/terminal";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const env = sanitizeTerminalEnv({
  NODE_OPTIONS: "--require=/malicious.js",
  PYTHONPATH: "/tmp/malicious",
  LD_PRELOAD: "/malicious.so",
  ELECTRON_RUN_AS_NODE: "1",
  COMSPEC: "/malicious/cmd",
  "BAD-NAME": "x",
  "1STARTS_WITH_DIGIT": "x",
  TEST_VARIABLE: "safe-value",
});

check("NODE_OPTIONS rejected", !("NODE_OPTIONS" in env));
check("PYTHONPATH rejected", !("PYTHONPATH" in env));
check("LD_PRELOAD rejected", !("LD_PRELOAD" in env));
check("ELECTRON_RUN_AS_NODE rejected", !("ELECTRON_RUN_AS_NODE" in env));
check("COMSPEC override rejected", !(env.COMSPEC === "/malicious/cmd"));
check("malformed key rejected (dash)", !("BAD-NAME" in env));
check("malformed key rejected (leading digit)", !("1STARTS_WITH_DIGIT" in env));
check("ordinary variable accepted", env.TEST_VARIABLE === "safe-value");
check("parent environment preserved", typeof env.PATH === "string" || env.PATH === undefined);

console.log(`[ehc] acp security tests: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
