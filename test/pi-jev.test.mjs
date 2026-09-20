import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateToolArguments } from "@earendil-works/pi-ai";
const { loadExtensions } = await import(
  new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const loaded = await loadExtensions([join(cwd, "pi-jev.ts")], cwd);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0].tools.get("jev_evaluate").definition;
const originalFetch = globalThis.fetch;
const originalKey = process.env.TYPESAFE_API_KEY;
const originalModel = process.env.TYPESAFE_DEFAULT_MODEL;
process.env.TYPESAFE_API_KEY = "test-only-key";
delete process.env.TYPESAFE_DEFAULT_MODEL;
after(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
  else process.env.TYPESAFE_DEFAULT_MODEL = originalModel;
});
const questions = {
  support: {
    type: "choice",
    instructions: "Does input.source support input.claim?",
    criteria: { yes: "Supports", no: "Does not support" },
  },
  present: { type: "noul", instructions: "Does input.source mention retries?" },
  relevance: { type: "score", instructions: "Rate relevance", criteria: ["Unrelated", "Relevant"] },
};
const response = {
  model: "jev-1.13.0",
  answers: {
    support: {
      type: "choice",
      choice: "no",
      probabilities: { yes: 0.1, no: 0.9 },
      confidence: 0.8,
    },
    present: { type: "noul", noul: 0.95 },
    relevance: {
      type: "score",
      score: 0.75,
      legend: { 0: "Unrelated", 1: "Relevant" },
      probabilities: { 0: 0.25, 1: 0.75 },
      confidence: 0.5,
    },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
};
async function run(params, signal) {
  const checked = validateToolArguments(tool, {
    id: "test",
    name: "jev_evaluate",
    arguments: params,
  });
  return tool.execute("test", checked, signal, undefined, { cwd });
}
test("shared evidence is evaluated in one mixed batch and raw judgments reach the model", async () => {
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(options.body);
    assert.deepEqual(body.state, {
      input: { claim: "All errors retry", source: "429 errors retry" },
      files: {},
    });
    assert.deepEqual(body.questions, questions);
    assert.equal(options.headers.Authorization, "Bearer test-only-key");
    return Response.json(response);
  };
  try {
    const result = await run({
      state: { claim: "All errors retry", source: "429 errors retry" },
      questions,
    });
    const content = JSON.parse(result.content[0].text);
    assert.deepEqual(content.answers, response.answers);
    assert.equal(content.model, "jev-1.13.0");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("file excerpts and inline claims share named state with exact provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-evidence-"));
  await writeFile(join(dir, "source.md"), "first\r\nsecond\r\nthird\r\n");
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.state, {
      input: { claim: "second" },
      files: { source: { path: join(dir, "source.md"), startLine: 2, endLine: 2, text: "second" } },
    });
    return Response.json(response);
  };
  try {
    await tool.execute(
      "test",
      {
        state: { claim: "second" },
        stateFiles: [{ name: "source", path: "@source.md", startLine: 2, endLine: 2 }],
        questions,
      },
      undefined,
      undefined,
      { cwd: dir },
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid evidence and rubrics fail before any API request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-invalid-"));
  await writeFile(join(dir, "source.txt"), "alpha\nbeta\n");
  await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(dir, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected request");
  };
  const file = { name: "source", path: join(dir, "source.txt") };
  const invalid = [
    [{ questions }, /Provide state/],
    [{ stateFiles: [file, file], questions }, /duplicate/],
    [{ stateFiles: [{ ...file, startLine: 3 }], questions }, /Invalid line range/],
    [{ stateFiles: [{ ...file, startLine: 2, endLine: 1 }], questions }, /Invalid line range/],
    [{ stateFiles: [{ ...file, path: join(dir, "missing") }], questions }, /ENOENT/],
    [{ stateFiles: [{ ...file, path: join(dir, "binary") }], questions }, /binary/],
    [{ stateFiles: [{ ...file, path: join(dir, "invalid-utf8") }], questions }, /UTF-8/],
    [{ state: "x".repeat(200_000), questions }, /192 KB/],
    [
      {
        state: "x",
        questions: { bad: { type: "score", instructions: "Rate it", criteria: ["Only one"] } },
      },
      /2–10/,
    ],
    [
      { state: "x", questions: { bad: { type: "choice", instructions: "Pick it", criteria: {} } } },
      /1–255/,
    ],
    [
      {
        state: "x",
        questions: {
          bad: { type: "noul", instructions: "Is it present?", criteria: { yes: "Yes" } },
        },
      },
      /true/,
    ],
  ];
  try {
    for (const [params, pattern] of invalid) await assert.rejects(run(params), pattern);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed or mismatched answers are rejected instead of becoming judgments", async () => {
  const malformed = [
    { ...response, answers: {} },
    { ...response, answers: { ...response.answers, present: { type: "choice", choice: "yes" } } },
    { ...response, answers: { ...response.answers, present: { type: "noul", noul: 2 } } },
    {
      ...response,
      answers: { ...response.answers, support: { ...response.answers.support, choice: "unknown" } },
    },
    {
      ...response,
      answers: {
        ...response.answers,
        support: { ...response.answers.support, probabilities: { yes: 0.9, no: 0.9 } },
      },
    },
    { ...response, usage: { input_tokens: -1, output_tokens: 0 } },
  ];
  try {
    for (const value of malformed) {
      globalThis.fetch = async () => Response.json(value);
      await assert.rejects(run({ state: "evidence", questions }), /invalid or incomplete/);
    }
    globalThis.fetch = async () => new Response("not json");
    await assert.rejects(run({ state: "evidence", questions }), /invalid JSON/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rate limits retry, while authentication and validation failures do not", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls < 3
      ? new Response(null, { status: 429, headers: { "retry-after": "0" } })
      : Response.json(response);
  try {
    await run({ state: "evidence", questions });
    assert.equal(calls, 3);
    for (const status of [401, 422]) {
      calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response("test-only-key", { status });
      };
      await assert.rejects(
        run({ state: "evidence", questions }),
        (e) => e.message.includes(String(status)) && !e.message.includes("test-only-key"),
      );
      assert.equal(calls, 1);
    }
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(null, { status: 529, headers: { "retry-after": "0" } });
    };
    await assert.rejects(run({ state: "evidence", questions }), /529/);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancellation stops a request or a retry wait", async () => {
  const aborted = new AbortController();
  aborted.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("unexpected");
  };
  try {
    await assert.rejects(run({ state: "evidence", questions }, aborted.signal));
    assert.equal(calls, 0);
    const controller = new AbortController();
    globalThis.fetch = async () => {
      calls++;
      setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    };
    await assert.rejects(
      run({ state: "evidence", questions }, controller.signal),
      (e) => e.name === "AbortError",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("files-only input and structured rubrics are sent without inventing inline evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-files-only-"));
  const path = join(dir, "source.txt");
  await writeFile(path, "one\ntwo\n");
  const batch = {
    present: {
      type: "noul",
      instructions: { question: "Does files.source.text contain one?" },
      criteria: { true: { meaning: "Present" }, false: null },
    },
    relevance: {
      type: "score",
      instructions: "Rate whether files.source.text answers the question.",
      criteria: [null, "Answers the question"],
    },
  };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.state, {
      files: { source: { path, startLine: 1, endLine: 2, text: "one\ntwo\n" } },
    });
    assert.deepEqual(body.questions, batch);
    return Response.json({
      ...response,
      answers: {
        present: { type: "noul", noul: 0.99 },
        relevance: {
          type: "score",
          score: 1,
          legend: { 0: null, 1: "Answers the question" },
          probabilities: { 0: 0, 1: 1 },
          confidence: 1,
        },
      },
    });
  };
  try {
    await run({ stateFiles: [{ name: "source", path }], questions: batch });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("credentials stay outside arguments and the model alias is fixed", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.equal(body.model, "jev-latest");
    assert.ok(!options.body.includes("test-only-key"));
    return Response.json(response);
  };
  try {
    delete process.env.TYPESAFE_API_KEY;
    await assert.rejects(run({ state: "evidence", questions }), /TYPESAFE_API_KEY/);
    assert.equal(calls, 0);
    process.env.TYPESAFE_API_KEY = "test-only-key";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-preview";
    await run({ state: "evidence", questions });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.TYPESAFE_API_KEY = "test-only-key";
    delete process.env.TYPESAFE_DEFAULT_MODEL;
  }
});

test("large distributions remain complete in a file and content stays valid JSON", async () => {
  const options = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [`candidate_${i}_${"x".repeat(40)}`, null]),
  );
  const probabilities = Object.fromEntries(Object.keys(options).map((k) => [k, 0.005]));
  const batch = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [
      `q${i}`,
      { type: "choice", instructions: "Choose a candidate", criteria: options },
    ]),
  );
  const answers = Object.fromEntries(
    Object.keys(batch).map((k) => [
      k,
      { type: "choice", choice: Object.keys(options)[0], probabilities, confidence: 0 },
    ]),
  );
  globalThis.fetch = async () => Response.json({ ...response, answers });
  let outputPath;
  try {
    const result = await run({ state: "candidates", questions: batch });
    const summary = JSON.parse(result.content[0].text);
    outputPath = summary.outputPath;
    assert.ok(outputPath);
    assert.ok(Buffer.byteLength(result.content[0].text) < 50_000);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")).answers, answers);
  } finally {
    globalThis.fetch = originalFetch;
    if (outputPath) await rm(join(outputPath, ".."), { recursive: true, force: true });
  }
});
