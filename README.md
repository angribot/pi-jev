# pi-jev

A single-file [pi](https://github.com/earendil-works/pi-mono) extension that exposes TypeSafe Jev as `jev_evaluate`. It evaluates supplied evidence against a batch of Choice, Score and Bool questions and returns the original typed judgments and probabilities.

The tool is a thin wrapper over pi's built-in classifier support: it resolves the catalog's `typesafe/jev-latest` classifier model through the runtime model registry and calls it with the session's credentials. It does not register its own provider, read `TYPESAFE_API_KEY` itself, or implement HTTP, retries or authentication.

The agent decides when to call it. It works with existing skills without changing their workflows or adding automatic routing hooks.

## Install

Requires pi 0.99.1 or later, which added classifier models and `ModelRegistry.classify()`. The extension uses Node built-ins and the packages provided by pi; the development dependencies are only needed to run this repository's checks.

Install the package:

```sh
pi install git:github.com/angribot/pi-jev
```

Or link the single extension file directly:

```sh
mkdir -p ~/.pi/agent/extensions
ln -s ~/repo/pi-jev/pi-jev.ts ~/.pi/agent/extensions/pi-jev.ts
```

Authenticate the TypeSafe provider with `/login`, or set `TYPESAFE_API_KEY` in the environment that starts pi. Then run `/reload` in pi. Without usable credentials the tool call fails with a message that says how to add them; pi itself starts normally.

Requests use the `jev-latest` alias, so they follow TypeSafe's newest stable release. The result's `model` is the classifier catalog ID that ran (`jev-latest` or the alias you resolve), and `usage` carries the token counts the service reported. pi prices those tokens from the catalog, so a model without a catalog price reports tokens at no cost. Pin a versioned ID instead of the alias if you have tuned thresholds to a specific release; check the service's own response for the exact version if you need it.

The wrapper uses only `typesafe/jev-latest`. To use another provider's Jev model, such as `openrouter/~typesafe/jev-latest`, call it directly through codemode's `models.classify()`.

## Tool input

Provide `state`, `stateFiles`, or both, plus a nonempty `questions` map:

```json
{
  "state": {
    "claim": "The SDK retries rate-limited requests automatically."
  },
  "stateFiles": [
    {
      "name": "sdk",
      "path": "./research/sdk.md",
      "startLine": 10,
      "endLine": 35
    }
  ],
  "questions": {
    "support": {
      "type": "choice",
      "instructions": "Does files.sdk.text support the complete claim in input.claim?",
      "criteria": {
        "supports": "The source supports the complete claim.",
        "contradicts": "The source contradicts the claim.",
        "insufficient": "The source does not establish the complete claim."
      }
    },
    "mentions_rate_limits": {
      "type": "bool",
      "instructions": "Does files.sdk.text discuss rate limits?"
    }
  }
}
```

Inline `state` can be a string, object or array. The extension assembles the classifier state as:

```text
input                  Inline state, omitted when not supplied
files.<name>.path       Absolute source path
files.<name>.startLine  First selected line
files.<name>.endLine    Last selected line
files.<name>.text       Selected source text
```

File names must be unique and match `[A-Za-z][A-Za-z0-9_-]*`. Paths resolve from pi's working directory; a leading `@` is accepted. Ranges are 1-indexed and inclusive, defaulting to the entire file. Empty files, invalid ranges, missing files and binary or invalid UTF-8 content fail explicitly. Excerpts preserve interior line endings and omit the selected range's final newline; whole-file reads preserve the decoded text.

The selected text and source paths are sent to the classifier provider. Only explicitly supplied materials are included; the extension does not collect the conversation or scan the repository.

### Questions

| Type     | Criteria                                                               | Result                                  |
| -------- | ---------------------------------------------------------------------- | --------------------------------------- |
| `choice` | Object with 1–255 named options; descriptions are plain text or `null` | `choice`, `probabilities`, `confidence` |
| `score`  | Ordered array of 2–10 descriptive levels, starting at level 0          | `score`, `confidence`                   |
| `bool`   | Optional object describing `true` and/or `false` as plain text         | `probability`, plus the `noul` alias    |
| `noul`   | Deprecated alias of `bool`; converted before the request               | Same as `bool`                          |

`bool` is pi's public classifier primitive. The wire protocol still calls it `noul`, and the runtime maps it, so the previous question type is accepted under its old name and rewritten to `bool` before the request. Answers carry both names: `probability` is the current field and `noul` repeats it, so existing thresholds keep working.

Instructions must be plain text, and criteria descriptions must be plain text or `null` (sent as an empty description). pi 0.99's classifier contract types `instructions` and criteria as strings, so the structured JSON descriptions and structured instructions that the standalone HTTP implementation accepted are no longer supported. The parameter schema rejects them before the tool runs; text is the only form the runtime can forward. `noul` questions without criteria, or with only one side described, still work: an undeclared side is sent as an empty description.

Each question must contain its complete meaning: question IDs are only response identifiers. Questions see the same state independently, so one question cannot use another question's answer in the same call.

## Results and failures

Model-visible content is JSON containing `model`, `answers`, `usage` and `elapsedMs`. The tool also returns `structuredContent` matching its `outputSchema`, which programmatic callers such as `codemode` scripts receive instead of the text, and records `details` for rendering.

The collapsed TUI shows the model, elapsed time and input tokens. Classifier usage is also reported on the tool result, so a `codemode` script that calls the tool contributes its tokens to the session total.

```json
{
  "model": "jev-latest",
  "answers": {
    "support": {
      "type": "choice",
      "choice": "insufficient",
      "probabilities": { "supports": 0.1, "contradicts": 0.05, "insufficient": 0.85 },
      "confidence": 0.8
    },
    "mentions_rate_limits": { "type": "bool", "probability": 0.97, "noul": 0.97 }
  },
  "usage": { "input_tokens": 812, "output_tokens": 12 },
  "elapsedMs": 940
}
```

- Choice/Score confidence describes distribution concentration, not correctness. `bool` is the probability of yes. The tool preserves raw outputs and leaves thresholds and actions to the caller.
- Output above pi's 50 KB / 2000-line display limit is saved as complete JSON in a private temporary directory. The tool returns a valid JSON summary with `outputPath`, and `structuredContent.response` is omitted in that case; use `read` to inspect the file. Files remain available for resumed sessions until the operating system removes them.
- The operation has a 30-second deadline and respects cancellation. Retries, timeouts and authentication belong to the runtime: pi applies provider retry policy, resolves request-time credentials, and reports provider failures without rejecting, so the tool turns a non-`stop` `stopReason` into an explicit `isError` tool result carrying the runtime's message. Failures after classification retain any reported usage; codemode callers receive an `error` field instead of answers. Provider error messages come from the runtime, which formats them without the request body when the error carries its own message.
- Invalid or incomplete answers fail explicitly. A missing or mismatched answer, an out-of-range probability, a choice outside its options, probabilities that do not sum to 1 within 0.01, or a score outside its levels all produce an error instead of a judgment. Service failures never become negative judgments.
- Local limits are 8 MB per source file and 192 KB per serialized classifier request. These are byte limits, not token estimates. The provider additionally enforces its model's token limits. Reduce evidence ranges or split questions when limits are reached; input is never silently truncated.

## Prompt guidance

The tool's description and `promptGuidelines` follow the [official TypeSafe skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md): supply relevant evidence, ask narrow questions, batch independent judgments, choose the primitive according to the answer's meaning, and interpret uncertainty in the task's context.

`writing-for-agents` was used to organize and shorten those instructions: invocation guidance stays near the tool, parameter-specific rules stay in the schema, and detailed operational reference stays here. TypeSafe's current documentation remains authoritative for service behavior:

- [HTTP API](https://docs.typesafe.ai/api.md)
- [State](https://docs.typesafe.ai/concepts/state.md)
- [Primitives](https://docs.typesafe.ai/primitives.md) and [structured criteria](https://docs.typesafe.ai/primitives/advanced.md)
- [Confidence](https://docs.typesafe.ai/confidence.md)
- [Models and limits](https://docs.typesafe.ai/models.md)

pi's [classifier model documentation](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md#use-classifier-models) documents the runtime surface this extension uses.

## Use from codemode

Classifier models are not chat models and do not appear in `/model`. The same judgments are reachable two ways:

- Call `jev_evaluate` from a `codemode` script when the state files, 192 KB request guard and answer validation are useful. The tool stays declared to the model; a script that also calls it gets the same validated result.
- Call the classifier directly from a script with `models.classify()` when you already have the state in hand:

```js
const jev = models.getModelOfType("classifier", "typesafe", "jev-latest");
const result = await models.classify(jev, {
  state: { message: "The change works, thanks." },
  questions: {
    approved: {
      type: "bool",
      instructions: "Does the user approve of the result?",
      criteria: { true: "Approval", false: "No approval" },
    },
  },
});
return result.answers;
```

`models.getModelOfType()` is synchronous; `models.getAvailableOfType()` is the async variant that lists models with working credentials. Direct calls bypass the tool's evidence assembly and validation. Batch independent questions in one `classify()` call; scripts can run at most four classifications concurrently per script. See [Choose a Model](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md) and [codemode](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/cli.md#how-codemode-works).

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
```

Tests load the real extension through pi's extension loader, validate tool arguments through pi-ai, and exercise the registered tool with temporary source files and a fake model registry that records `classify()` calls. They require no API key and make no live TypeSafe requests. They verify integration behavior, not Jev's judgment accuracy on real tasks.

The deployable extension remains entirely in `pi-jev.ts`; tests and documentation are separate repository artifacts.
