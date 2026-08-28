import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./app.js", import.meta.url), "utf8");

function functionBody(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} should exist`);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(brace + 1, index);
  }
  throw new Error(`Could not parse ${name}`);
}

test("background polling updates one card without rebuilding the order grid", () => {
  const body = functionBody("pollOrder");
  assert.match(body, /updateOrderCard\(recordId\)/);
  assert.doesNotMatch(body, /\brender\(\)/);
});

test("submitting one share link keeps the other cards mounted", () => {
  const body = functionBody("submitOrder");
  assert.match(body, /updateOrderCard\(recordId\)/);
  assert.doesNotMatch(body, /\brender\(\)/);
});
