import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_HEAP_MB = "8192";
const heapMb = process.env.ITESTFLOW_NODE_HEAP_MB ?? DEFAULT_HEAP_MB;
const nodeOptions = process.env.NODE_OPTIONS ?? "";
const hasHeapOption = /--max[-_]old[-_]space[-_]size(?:=|\s|$)/.test(nodeOptions);
const mergedNodeOptions = hasHeapOption ? nodeOptions : `${nodeOptions} --max-old-space-size=${heapMb}`.trim();
const nextBin = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url));

const child = spawn(process.execPath, [nextBin, "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_OPTIONS: mergedNodeOptions,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 0);
});
