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

/** Stand-in classifier model; the fake registry only ever compares identity. */
const model = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  name: "Jev (latest)",
  api: "typesafe-system-one",
  baseUrl: "https://api.typesafe.ai/v1",
  contextWindow: 128_000,
  cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const questions = {
  support: {
    type: "choice",
    instructions: "Does input.source support input.claim?",
    criteria: { yes: "Supports", no: "Does not support" },
  },
  present: { type: "noul", instructions: "Does input.source mention retries?" },
  relevance: { type: "score", instructions: "Rate relevance", criteria: ["Unrelated", "Relevant"] },
};

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 };
const answers = {
  support: {
    type: "choice",
    choice: "no",
    probabilities: { yes: 0.1, no: 0.9 },
    confidence: 0.8,
  },
  present: { type: "bool", probability: 0.95 },
  relevance: { type: "score", score: 0.75, confidence: 0.5 },
};
const classifierResult = {
  api: "typesafe-system-one",
  provider: "typesafe",
  model: "jev-latest",
  answers,
  usage,
  stopReason: "stop",
  timestamp: 0,
};

let calls = [];
after(() => {
  calls = [];
});
/** Runs the tool through the fake runtime registry and returns the result plus recorded calls. */
async function run(params, options = {}) {
  calls = [];
  const checked = validateToolArguments(tool, {
    id: "test",
    name: "jev_evaluate",
    arguments: params,
  });
  const registry = {
    findOfType(type, provider, id) {
      assert.equal(type, "classifier");
      if ("model" in options) return options.model;
      return provider === "typesafe" && id === "jev-latest" ? model : undefined;
    },
    async classify(classifier, context, requestOptions) {
      calls.push({ classifier, context, requestOptions });
      return (options.classify ?? (() => classifierResult))(context, requestOptions);
    },
  };
  const result = await tool.execute("test", checked, options.signal, undefined, {
    cwd: options.cwd ?? cwd,
    modelRegistry: registry,
  });
  return { result, calls };
}

/** The classifier result the fake registry returns, with selected answer overrides. */
function resultWith(overrides = {}) {
  return { ...classifierResult, ...overrides };
}

test("shared evidence reaches the built-in classifier in one mixed batch", async () => {
  const { result, calls } = await run({
    state: { claim: "All errors retry", source: "429 errors retry" },
    questions,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].classifier, model);
  assert.deepEqual(calls[0].context.state, {
    input: { claim: "All errors retry", source: "429 errors retry" },
    files: {},
  });
  assert.deepEqual(calls[0].context.questions, {
    support: {
      type: "choice",
      instructions: "Does input.source support input.claim?",
      criteria: { yes: "Supports", no: "Does not support" },
    },
    // The runtime primitive is bool; the deprecated noul alias is accepted and rewritten.
    present: {
      type: "bool",
      instructions: "Does input.source mention retries?",
      criteria: { true: "", false: "" },
    },
    relevance: {
      type: "score",
      instructions: "Rate relevance",
      criteria: ["Unrelated", "Relevant"],
    },
  });
  const content = JSON.parse(result.content[0].text);
  assert.deepEqual(content.answers, {
    support: answers.support,
    present: { type: "bool", probability: 0.95, noul: 0.95 },
    relevance: answers.relevance,
  });
  assert.equal(content.model, "jev-latest");
  assert.deepEqual(content.usage, { input_tokens: 100, output_tokens: 20 });
  assert.equal(result.usage.input, 100);
  assert.equal(result.usage.output, 20);
});

test("structuredContent carries the same answers for codemode scripts", async () => {
  const { result } = await run({ state: "evidence", questions });
  const content = JSON.parse(result.content[0].text);
  assert.equal(result.structuredContent.answerCount, 3);
  assert.equal(result.structuredContent.model, content.model);
  assert.deepEqual(result.structuredContent.usage, content.usage);
  assert.deepEqual(result.structuredContent.response.answers, content.answers);
});

test("file excerpts and inline claims share named state with exact provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-evidence-"));
  await writeFile(join(dir, "source.md"), "first\r\nsecond\r\nthird\r\n");
  try {
    const { calls } = await run(
      {
        state: { claim: "second" },
        stateFiles: [{ name: "source", path: "@source.md", startLine: 2, endLine: 2 }],
        questions: { present: questions.present },
      },
      { cwd: dir },
    );
    assert.deepEqual(calls[0].context.state, {
      input: { claim: "second" },
      files: {
        source: { path: join(dir, "source.md"), startLine: 2, endLine: 2, text: "second" },
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid evidence and rubrics fail before any classifier call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-invalid-"));
  await writeFile(join(dir, "source.txt"), "alpha\nbeta\n");
  await writeFile(join(dir, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(join(dir, "invalid-utf8"), Buffer.from([0xff, 0xfe]));
  const file = { name: "source", path: join(dir, "source.txt") };
  const single = { questions: { present: questions.present } };
  const invalid = [
    [{ questions }, /Provide state/],
    [{ stateFiles: [file, file], ...single }, /duplicate/],
    [{ stateFiles: [{ ...file, startLine: 3 }], ...single }, /Invalid line range/],
    [{ stateFiles: [{ ...file, startLine: 2, endLine: 1 }], ...single }, /Invalid line range/],
    [{ stateFiles: [{ ...file, path: join(dir, "missing") }], ...single }, /ENOENT/],
    [{ stateFiles: [{ ...file, path: join(dir, "binary") }], ...single }, /binary/],
    [{ stateFiles: [{ ...file, path: join(dir, "invalid-utf8") }], ...single }, /UTF-8/],
    [{ state: "x".repeat(200_000), ...single }, /192 KB/],
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
          bad: { type: "bool", instructions: "Is it present?", criteria: { yes: "Yes" } },
        },
      },
      /true/,
    ],
    [
      {
        state: "x",
        questions: {
          // Structured criteria are rejected by the parameter schema before the handler runs.
          bad: { type: "noul", instructions: "Is it present?", criteria: { true: {} } },
        },
      },
      /must be string/,
    ],
    [
      {
        state: "x",
        questions: {
          bad: { type: "noul", instructions: "" },
        },
      },
      /fewer than 1 character/,
    ],
  ];
  try {
    for (const [params, pattern] of invalid) {
      await assert.rejects(run(params), pattern);
      assert.equal(calls.length, 0, `expected no classifier call for ${JSON.stringify(params)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed or mismatched answers are rejected instead of becoming judgments", async () => {
  const malformed = [
    { answers: { ...answers, present: { type: "bool", probability: 2 } } },
    { answers: { ...answers, present: undefined } },
    {
      answers: {
        ...answers,
        support: { ...answers.support, probabilities: { yes: 0.1, no: 0.1, unrelated: 0.8 } },
      },
    },
    { answers: { ...answers, support: { ...answers.support, choice: "unknown" } } },
    { answers: { ...answers, support: { ...answers.support, probabilities: { yes: 9, no: 1 } } } },
    {
      answers: {
        ...answers,
        support: { ...answers.support, probabilities: { yes: 0.9, no: 0.9 } },
      },
    },
    { answers: { ...answers, relevance: { type: "score", score: 2, confidence: 0.5 } } },
    { answers: { ...answers, relevance: { type: "score", score: 0.5 } } },
  ];
  for (const value of malformed) {
    const { result } = await run(
      { state: "evidence", questions },
      { classify: () => resultWith(value) },
    );
    assert.equal(result.isError, true);
    assert.match(result.structuredContent.error, /invalid or incomplete/);
    assert.equal(result.usage, usage);
    assert.equal(calls.length, 1);
  }
});

test("runtime failures surface as errors and never become negative judgments", async () => {
  const failed = await run(
    { state: "evidence", questions },
    {
      classify: () =>
        resultWith({
          answers: {},
          stopReason: "error",
          errorMessage: "System One API error (429): rate limited",
        }),
    },
  );
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.structuredContent.error, /rate limited/);
  assert.equal(failed.result.usage, usage);
  const cancelled = await run(
    { state: "evidence", questions },
    { classify: () => resultWith({ answers: {}, stopReason: "aborted" }) },
  );
  assert.equal(cancelled.result.isError, true);
  assert.match(cancelled.result.structuredContent.error, /cancelled/);
  assert.equal(cancelled.result.usage, usage);
});

test("a missing classifier model explains how to add credentials", async () => {
  await assert.rejects(run({ state: "evidence", questions }, { model: undefined }), /credentials/);
  assert.equal(calls.length, 0);
});

test("cancellation stops the evaluation before the classifier call", async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(run({ state: "evidence", questions }, { signal: aborted.signal }));
  assert.equal(calls.length, 0);
});

test("files-only input and partial bool criteria stay plain text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-files-only-"));
  const path = join(dir, "source.txt");
  await writeFile(path, "one\ntwo\n");
  const batch = {
    present: {
      type: "noul",
      instructions: "Does files.source.text contain one?",
      criteria: { true: "Present", false: null },
    },
    relevance: {
      type: "score",
      instructions: "Rate whether files.source.text answers the question.",
      criteria: [null, "Answers the question"],
    },
  };
  try {
    const { calls: made } = await run(
      { stateFiles: [{ name: "source", path }], questions: batch },
      {
        cwd: dir,
        classify: () =>
          resultWith({
            answers: {
              present: { type: "bool", probability: 0.99 },
              relevance: { type: "score", score: 1, confidence: 1 },
            },
          }),
      },
    );
    assert.deepEqual(made[0].context.state, {
      files: { source: { path, startLine: 1, endLine: 2, text: "one\ntwo\n" } },
    });
    assert.deepEqual(made[0].context.questions, {
      present: {
        type: "bool",
        instructions: "Does files.source.text contain one?",
        criteria: { true: "Present", false: "" },
      },
      relevance: {
        type: "score",
        instructions: "Rate whether files.source.text answers the question.",
        criteria: ["", "Answers the question"],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
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
  const largeAnswers = Object.fromEntries(
    Object.keys(batch).map((k) => [
      k,
      { type: "choice", choice: Object.keys(options)[0], probabilities, confidence: 0 },
    ]),
  );
  let outputPath;
  try {
    const { result } = await run(
      { state: "candidates", questions: batch },
      { classify: () => resultWith({ answers: largeAnswers }) },
    );
    const summary = JSON.parse(result.content[0].text);
    outputPath = summary.outputPath;
    assert.ok(outputPath);
    assert.ok(Buffer.byteLength(result.content[0].text) < 50_000);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")).answers, largeAnswers);
    assert.equal(result.structuredContent.outputPath, outputPath);
    assert.equal(result.structuredContent.response, undefined);
    assert.equal(result.structuredContent.answerCount, 5);
  } finally {
    if (outputPath) await rm(join(outputPath, ".."), { recursive: true, force: true });
  }
});
