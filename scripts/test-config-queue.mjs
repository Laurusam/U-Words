import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";

// Test the shipped TypeScript helper without introducing a separate test runtime.
const source = await readFile(new URL("../src/lib/writeQueue.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
const { createWriteQueue } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("configuration writes are sequential and snapshot mutable inputs", async () => {
  const output = [];
  let inFlight = 0;
  const save = createWriteQueue(async (config) => {
    assert.equal(++inFlight, 1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    output.push(config);
    --inFlight;
  });
  const config = { asrProvider: "local", dictionary: ["U-Words"] };
  const first = save(config);
  config.dictionary.push("changed-after-enqueue");
  const second = save({ asrProvider: "qwen", dictionary: [] });
  await Promise.all([first, second]);
  assert.deepEqual(output, [{ asrProvider: "local", dictionary: ["U-Words"] }, { asrProvider: "qwen", dictionary: [] }]);
});

test("failed writes report an error without blocking the next configuration", async () => {
  const output = [];
  const save = createWriteQueue(async (config) => {
    if (config === "bad") throw new Error("disk write failed");
    output.push(config);
  });
  const first = save("bad");
  const second = save("qwen");
  await assert.rejects(first, /disk write failed/);
  await second;
  assert.deepEqual(output, ["qwen"]);
});
