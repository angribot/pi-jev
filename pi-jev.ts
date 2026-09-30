import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StringEnum, type ClassifierQuestion, type JsonObject } from "@earendil-works/pi-ai";
import {
  keyHint,
  truncateHead,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const PROVIDER = "typesafe";
const MODEL_ID = "jev-latest";
// USD per million tokens; jev-latest currently aliases jev-1.13.0.
// https://docs.typesafe.ai/models.md — input $0.042/Mtok, output free.
const DEFAULT_COST = { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 };
const TIMEOUT_MS = 30_000;
// Local byte budget, not an estimate of the model's token limit. The service enforces tokens.
const MAX_STATE_BYTES = 192_000;
const MAX_FILE_BYTES = 8_000_000;

const descriptionSchema = Type.Union([Type.String(), Type.Null()], {
  description: "Plain-text description. null is sent as an empty description.",
});

const parameters = Type.Object(
  {
    state: Type.Optional(
      Type.Union(
        [Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())],
        {
          description:
            "Inline evidence. Sent as input in the classifier state; may be combined with stateFiles.",
        },
      ),
    ),
    stateFiles: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String({
              pattern: "^[A-Za-z][A-Za-z0-9_-]*$",
              description: "Unique source name; reference files.<name>.text in questions.",
            }),
            path: Type.String({
              minLength: 1,
              description:
                "UTF-8 text file, relative to current working directory or absolute. Maximum 8 MB per file.",
            }),
            startLine: Type.Optional(
              Type.Integer({ minimum: 1, description: "First line, inclusive; defaults to 1." }),
            ),
            endLine: Type.Optional(
              Type.Integer({
                minimum: 1,
                description: "Last line, inclusive; defaults to the last line.",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    ),
    questions: Type.Record(
      Type.String({ minLength: 1 }),
      Type.Object(
        {
          type: StringEnum(["choice", "score", "bool", "noul"] as const, {
            description:
              "bool is a yes/no question; noul is a deprecated alias of bool kept for existing callers.",
          }),
          instructions: Type.String({
            minLength: 1,
            description: "Complete plain-text question. The question sees state only.",
          }),
          criteria: Type.Optional(
            Type.Union(
              [
                Type.Record(Type.String(), descriptionSchema),
                Type.Array(descriptionSchema),
                Type.Null(),
              ],
              {
                description:
                  "choice: object mapping 1–255 option names to descriptions. score: ordered array of 2–10 descriptive levels. bool/noul: object describing true and/or false. Descriptions must be plain text; null means an empty description.",
              },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      { minProperties: 1 },
    ),
  },
  { additionalProperties: false },
);
export type JevEvaluateInput = Static<typeof parameters>;

type BoolAnswer = { type: "bool"; probability: number; noul: number };
type Usage = { input_tokens: number; output_tokens: number };
type PublicAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | BoolAnswer;
type JevResponse = { model: string; answers: Record<string, PublicAnswer>; usage: Usage };

const choiceAnswerSchema = Type.Object({
  type: Type.Literal("choice"),
  choice: Type.String(),
  probabilities: Type.Record(Type.String(), Type.Number()),
  confidence: Type.Number(),
});
const scoreAnswerSchema = Type.Object({
  type: Type.Literal("score"),
  score: Type.Number(),
  confidence: Type.Number(),
});
const boolAnswerSchema = Type.Object({
  type: Type.Literal("bool"),
  probability: Type.Number(),
  noul: Type.Number({ description: "Deprecated alias of probability." }),
});
const usageSchema = Type.Object({
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
});
const responseSchema = Type.Object({
  model: Type.String(),
  answers: Type.Record(
    Type.String(),
    Type.Union([choiceAnswerSchema, scoreAnswerSchema, boolAnswerSchema]),
  ),
  usage: usageSchema,
  elapsedMs: Type.Integer({ minimum: 0 }),
});

const outputSchema = Type.Object(
  {
    model: Type.String(),
    answerCount: Type.Integer({ minimum: 0 }),
    usage: usageSchema,
    elapsedMs: Type.Integer({ minimum: 0 }),
    outputPath: Type.Optional(
      Type.String({
        description: "File holding the complete response; set only when the display text is large.",
      }),
    ),
    response: Type.Optional(responseSchema),
    error: Type.Optional(Type.String({ description: "Failure message; no answers are returned." })),
  },
  {
    description:
      "Classifier result. response holds every answer; it is omitted when outputPath points to the complete JSON.",
  },
);

type ToolOutput = Static<typeof outputSchema>;
type Details = { response: JevResponse; elapsedMs: number; outputPath?: string } | undefined;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain-text description. A null description becomes an empty string. */
function description(value: unknown): string {
  return value === null ? "" : String(value);
}

function validateQuestions(questions: JevEvaluateInput["questions"]): {
  ids: string[];
  questions: Record<string, ClassifierQuestion>;
} {
  if (!object(questions) || Object.keys(questions).length === 0)
    throw new Error("Provide at least one question.");
  const ids: string[] = [];
  const validated: Record<string, ClassifierQuestion> = Object.create(null);
  for (const [id, q] of Object.entries(questions)) {
    if (
      !id.trim() ||
      !object(q) ||
      q.instructions === null ||
      typeof q.instructions !== "string" ||
      !q.instructions.trim()
    )
      throw new Error(
        `Question ${id} needs explicit plain-text instructions. The built-in classifier runtime does not support structured instructions.`,
      );
    const c = q.criteria;
    if (q.type === "choice") {
      if (
        !object(c) ||
        Object.keys(c).length < 1 ||
        Object.keys(c).length > 255 ||
        Object.entries(c).some(
          ([key, value]) => !key.trim() || (value !== null && typeof value !== "string"),
        )
      ) {
        throw new Error(
          `Choice ${id} needs 1–255 named options with plain-text descriptions; the built-in classifier runtime does not support structured criteria.`,
        );
      }
      validated[id] = {
        type: "choice",
        instructions: q.instructions,
        criteria: Object.fromEntries(
          Object.entries(c).map(([key, value]) => [key, description(value)]),
        ),
      };
      ids.push(id);
      continue;
    }
    if (q.type === "score") {
      if (
        !Array.isArray(c) ||
        c.length < 2 ||
        c.length > 10 ||
        !c.every((value) => value === null || typeof value === "string")
      ) {
        throw new Error(
          `Score ${id} needs 2–10 plain-text descriptive levels; the built-in classifier runtime does not support structured criteria.`,
        );
      }
      validated[id] = { type: "score", instructions: q.instructions, criteria: c.map(description) };
      ids.push(id);
      continue;
    }
    if (q.type !== "bool" && q.type !== "noul") throw new Error(`Unknown question type for ${id}.`);
    if (
      c !== undefined &&
      c !== null &&
      (!object(c) ||
        Object.entries(c).some(
          ([key, value]) =>
            !["true", "false"].includes(key) || (value !== null && typeof value !== "string"),
        ))
    ) {
      throw new Error(
        `Bool ${id} criteria must describe true and/or false as plain text; the built-in classifier runtime does not support structured criteria.`,
      );
    }
    // The runtime's public primitive is bool; noul stays an accepted alias for existing callers.
    const criteria = object(c)
      ? Object.fromEntries(Object.entries(c).map(([key, value]) => [key, description(value)]))
      : undefined;
    validated[id] = {
      type: "bool",
      instructions: q.instructions,
      criteria: { true: criteria?.true ?? "", false: criteria?.false ?? "" },
    };
    ids.push(id);
  }
  return { ids, questions: Object.fromEntries(Object.entries(validated)) };
}

async function buildState(
  params: JevEvaluateInput,
  cwd: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (params.state === undefined && !params.stateFiles?.length)
    throw new Error("Provide state or stateFiles.");
  const files: Record<string, unknown> = {};
  const state: Record<string, unknown> = {
    ...(params.state !== undefined ? { input: params.state } : {}),
    files,
  };
  for (const source of params.stateFiles ?? []) {
    signal.throwIfAborted();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(source.name) || Object.hasOwn(files, source.name)) {
      throw new Error(`Invalid or duplicate source name: ${source.name}`);
    }
    const path = resolve(cwd, source.path.replace(/^@/, ""));
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error(`Source must be a regular text file of at most 8 MB: ${path}`);
    const buffer = await readFile(path, { signal });
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`Source is not valid UTF-8 text: ${path}`);
    }
    if (content.includes("\0")) throw new Error(`Source contains binary data: ${path}`);
    // Keep original line endings inside excerpts; a final newline does not add a phantom line.
    const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const startLine = source.startLine ?? 1;
    const endLine = source.endLine ?? lines.length;
    if (
      !Number.isSafeInteger(startLine) ||
      !Number.isSafeInteger(endLine) ||
      startLine < 1 ||
      endLine < startLine ||
      endLine > lines.length
    ) {
      throw new Error(
        `Invalid line range ${startLine}–${endLine} for ${path} (${lines.length} lines).`,
      );
    }
    const excerpt =
      source.startLine === undefined && source.endLine === undefined
        ? content
        : lines
            .slice(startLine - 1, endLine)
            .join("")
            .replace(/\r?\n$/, "");
    files[source.name] = { path, startLine, endLine, text: excerpt };
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_STATE_BYTES)
      throw new Error(
        "Evidence exceeds the 192 KB local request limit; select smaller file ranges.",
      );
  }
  return state as JsonObject;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Runtime usage reports `input`/`output`; the model-facing shape keeps Jev's token names. */
function tokenUsage(value: unknown): Usage | undefined {
  if (!object(value)) return undefined;
  const input = value.input;
  const output = value.output;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) return undefined;
  if ((input as number) < 0 || (output as number) < 0) return undefined;
  return { input_tokens: input as number, output_tokens: output as number };
}

function validateAnswer(id: string, question: ClassifierQuestion, answer: unknown): PublicAnswer {
  const invalid = (why: string): never => {
    throw new Error(`Jev returned an invalid or incomplete answer for ${id}: ${why}.`);
  };
  if (!object(answer)) return invalid("no answer object");
  if (question.type === "bool") {
    if (answer.type !== "bool" || !probability(answer.probability))
      return invalid("expected a bool probability");
    return { type: "bool", probability: answer.probability, noul: answer.probability };
  }
  if (question.type === "choice") {
    if (answer.type !== "choice" || typeof answer.choice !== "string")
      return invalid("expected a choice");
    if (!object(answer.probabilities) || !probability(answer.confidence))
      return invalid("expected probabilities and confidence");
    const keys = Object.keys(question.criteria);
    const probabilities: Record<string, number> = Object.create(null);
    for (const [key, value] of Object.entries(answer.probabilities)) {
      if (!probability(value)) return invalid("expected probabilities and confidence");
      probabilities[key] = value;
    }
    if (
      Object.keys(probabilities).length !== keys.length ||
      !keys.includes(answer.choice) ||
      !keys.every((key) => Object.hasOwn(probabilities, key))
    )
      return invalid("choice and probabilities do not match the options");
    const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
    if (Math.abs(total - 1) > 0.01) return invalid("probabilities do not sum to 1");
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: Object.fromEntries(Object.entries(probabilities)),
      confidence: answer.confidence,
    };
  }
  const levels = question.criteria;
  if (
    answer.type !== "score" ||
    typeof answer.score !== "number" ||
    !Number.isFinite(answer.score) ||
    !probability(answer.confidence) ||
    answer.score < 0 ||
    answer.score > levels.length - 1
  )
    return invalid("expected a score within the declared levels");
  return { type: "score", score: answer.score, confidence: answer.confidence };
}

export default function registerJev(pi: ExtensionAPI): void {
  pi.registerTool<typeof parameters, Details>({
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description:
      "Evaluate supplied evidence against a batch of narrow Choice, Score and Bool questions using pi's built-in TypeSafe Jev classifier. Returns raw typed answers and probabilities, not explanations. Reference inline evidence as input and file excerpts as files.<name>.text in instructions. Supply state, stateFiles, or both. Files must be UTF-8, at most 8 MB each; ranges are 1-indexed and inclusive. Local request limit: 192 KB; provider token limits also apply. Results over 50 KB or 2000 lines are saved as complete JSON with a file pointer. noul is accepted as a deprecated alias of bool.",
    promptSnippet: "Make batched semantic judgments against supplied evidence using Jev",
    promptGuidelines: [
      "Use jev_evaluate when classification, candidate ranking or evidence checks benefit from narrow semantic judgments. Supply relevant original evidence and explicit criteria; use code for counting, exact lookups and execution.",
      "Batch independent jev_evaluate questions over shared evidence. Each question needs complete instructions; it sees state only. Make a second request when an earlier answer is needed to obtain evidence or construct the next question.",
      "For jev_evaluate, use Choice for competing options (include no-match when applicable), bool for a yes/no condition or each independent label, and per-item Score for graded ranking with concrete, comparable levels.",
      "Interpret jev_evaluate uncertainty per task: Choice/Score confidence measures distribution concentration; bool is the probability of yes. Escalate uncertain evidence checks to source inspection or reasoning, and evaluate decision thresholds on representative data.",
    ],
    parameters,
    outputSchema,
    async execute(_id, params, signal, onUpdate, ctx: ExtensionToolContext) {
      const started = Date.now();
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      combined.throwIfAborted();
      const { ids, questions } = validateQuestions(params.questions);
      const state = await buildState(params, ctx.cwd, combined);
      if (Buffer.byteLength(JSON.stringify({ state, questions })) > MAX_STATE_BYTES)
        throw new Error(
          "Jev request exceeds the 192 KB local limit; select smaller evidence ranges or split the batch.",
        );
      const model = ctx.modelRegistry.findOfType("classifier", PROVIDER, MODEL_ID);
      if (!model)
        throw new Error(
          `Model ${PROVIDER}/${MODEL_ID} is not available. Add TypeSafe credentials with /login, TYPESAFE_API_KEY or another credential source, then retry.`,
        );
      onUpdate?.({
        content: [{ type: "text", text: "Evaluating with Jev..." }],
        details: undefined,
      });
      // Keep catalog pricing when present; Pi currently lists direct Jev at zero cost.
      const pricedModel =
        model.cost &&
        (model.cost.input ||
          model.cost.output ||
          model.cost.cacheRead ||
          model.cost.cacheWrite ||
          model.cost.tiers?.length)
          ? model
          : { ...model, cost: DEFAULT_COST };
      const result = await ctx.modelRegistry.classify(
        pricedModel,
        { state, questions },
        { signal: combined },
      );
      try {
        combined.throwIfAborted();
        if (result.stopReason !== "stop")
          throw new Error(
            result.stopReason === "aborted"
              ? "Jev evaluation was cancelled."
              : `Jev evaluation failed: ${result.errorMessage ?? "unknown error"}`,
          );
        const answers = Object.fromEntries(
          ids.map((id) => [id, validateAnswer(id, questions[id], result.answers[id])]),
        );
        const response: JevResponse = {
          model: result.model,
          answers,
          usage: tokenUsage(result.usage) ?? { input_tokens: 0, output_tokens: 0 },
        };
        const elapsedMs = Date.now() - started;
        const details: Details = { response, elapsedMs };
        const full = JSON.stringify({ ...response, elapsedMs });
        const answerCount = Object.keys(answers).length;
        let structured: ToolOutput = {
          model: response.model,
          answerCount,
          usage: response.usage,
          elapsedMs,
          response: { ...response, elapsedMs },
        };
        let content = full;
        if (truncateHead(full).truncated) {
          // Retain the file for resumed sessions; the OS manages its temporary lifetime.
          const dir = await mkdtemp(join(tmpdir(), "pi-jev-"));
          details.outputPath = join(dir, "response.json");
          await writeFile(details.outputPath, full, { mode: 0o600, signal: combined });
          structured = {
            model: response.model,
            answerCount,
            usage: response.usage,
            elapsedMs,
            outputPath: details.outputPath,
          };
          content = JSON.stringify({
            model: response.model,
            questionCount: answerCount,
            usage: response.usage,
            elapsedMs,
            outputPath: details.outputPath,
            note: "Full response exceeds the display limit. Read outputPath for all answers and probabilities.",
          });
        }
        return {
          content: [{ type: "text", text: content }],
          details,
          structuredContent: structured as never,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      } catch (error) {
        // A provider may have consumed tokens even when parsing or postprocessing fails.
        const message = error instanceof Error ? error.message : String(error);
        const structured: ToolOutput = {
          model: result.model,
          answerCount: 0,
          usage: tokenUsage(result.usage) ?? { input_tokens: 0, output_tokens: 0 },
          elapsedMs: Date.now() - started,
          error: message,
        };
        return {
          content: [{ type: "text", text: message }],
          details: undefined,
          isError: true,
          structuredContent: structured as never,
          ...(result.usage ? { usage: result.usage } : {}),
        };
      }
    },
    renderCall(args, theme) {
      const count = args.questions ? Object.keys(args.questions).length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("jev_evaluate ")) + theme.fg("dim", `${count} questions`),
        0,
        0,
      );
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const content = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (context.isError) return new Text(theme.fg("error", content), 0, 0);
      if (isPartial) return new Text(theme.fg("warning", "Evaluating with Jev..."), 0, 0);
      if (expanded || !result.details) return new Text(theme.fg("toolOutput", content), 0, 0);
      const { response, elapsedMs } = result.details;
      return new Text(
        theme.fg(
          "dim",
          `${response.model} | ${elapsedMs} ms | ${response.usage.input_tokens} input tokens | ${keyHint("app.tools.expand", "to expand")}`,
        ),
        0,
        0,
      );
    },
  });
}
