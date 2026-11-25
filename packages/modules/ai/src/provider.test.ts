import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createFakeProvider, createLlmProvider, createXaiProvider, readXaiStream } from "./provider.ts";

test("the fake provider records the request and returns the script", async () => {
  const provider = createFakeProvider();
  provider.useScript([{ text: "hello", toolCalls: [{ name: "simulate_payroll_item", arguments: { ok: true } }] }]);
  const completion = await provider.complete({
    messages: [{ role: "user", content: "ping" }],
    tools: [],
  });
  assert.equal(completion.text, "hello");
  assert.equal(completion.toolCalls[0]?.name, "simulate_payroll_item");
  assert.equal(provider.requests[0]?.messages[0]?.content, "ping");
  const events = [];
  for await (const event of provider.stream({ messages: [{ role: "user", content: "again" }], tools: [] })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["done"]);
  assert.equal(provider.requests.length, 2);
});

test("createLlmProvider defaults to fake and rejects an unknown name", () => {
  assert.equal(createLlmProvider({}).name, "fake");
  assert.equal(createLlmProvider({ LLM_PROVIDER: "xai", XAI_API_KEY: "test-key" }).name, "xai");
  assert.throws(() => createLlmProvider({ LLM_PROVIDER: "openai" }), /fake or xai/);
});

test("the xAI provider throws before fetch when the key is missing", async () => {
  const provider = createXaiProvider({});
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("network");
  }) as typeof fetch;
  try {
    await assert.rejects(
      provider.complete({ messages: [{ role: "user", content: "3175012345670001" }], tools: [] }),
      /XAI_API_KEY is not set/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("an xAI error does not include the response body", async () => {
  const provider = createXaiProvider({ XAI_API_KEY: "test-key" });
  const original = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(new Response("secret 3175012345670001", { status: 503 }))) as typeof fetch;
  try {
    await assert.rejects(
      provider.complete({ messages: [], tools: [] }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "xAI request failed with status 503.");
        assert.equal(error.message.includes("3175012345670001"), false);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("readXaiStream yields text from an SSE body", async () => {
  const raw = `data: ${JSON.stringify({ choices: [{ delta: { content: "halo" } }] })}\n\ndata: [DONE]\n\n`;
  const body = Readable.toWeb(Readable.from([Buffer.from(raw)])) as ReadableStream<Uint8Array>;
  const events = [];
  for await (const event of readXaiStream(body)) events.push(event);
  assert.equal(events[0]?.type, "text");
  assert.equal(events.at(-1)?.type, "done");
});
