import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { keyHint, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 30_000;
// Local byte budgets, not estimates of Jev's token limits. The API enforces tokens.
const MAX_REQUEST_BYTES = 192_000;
const MAX_FILE_BYTES = 8_000_000;

const contentSchema = Type.Union([
  Type.String(),
  Type.Record(Type.String(), Type.Unknown()),
  Type.Array(Type.Unknown()),
]);
const parameters = Type.Object(
  {
    state: Type.Optional(
      Type.Union(
        [Type.String(), Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())],
        {
          description:
            "Inline evidence. Sent as input in Jev state; may be combined with stateFiles.",
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
          type: StringEnum(["choice", "score", "noul"] as const),
          instructions: contentSchema,
          criteria: Type.Optional(
            Type.Union([contentSchema, Type.Null()], {
              description:
                "choice: object mapping 1–255 option names to descriptions (or null). score: ordered array of 2–10 descriptive levels. noul: optional object with true/false descriptions. Descriptions may be structured JSON.",
            }),
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
type JsonObject = Record<string, unknown>;
type JevResponse = {
  model: string;
  answers: Record<string, JsonObject>;
  usage: { input_tokens: number; output_tokens: number };
};
type Details = { response: JevResponse; elapsedMs: number; outputPath?: string };

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDescription(value: unknown): boolean {
  return value === null || typeof value === "string" || object(value) || Array.isArray(value);
}

function validateQuestions(questions: JevEvaluateInput["questions"]): void {
  if (!object(questions) || Object.keys(questions).length === 0)
    throw new Error("Provide at least one question.");
  for (const [id, q] of Object.entries(questions)) {
    if (
      !id.trim() ||
      !object(q) ||
      q.instructions === null ||
      !isDescription(q.instructions) ||
      (typeof q.instructions === "string" && !q.instructions.trim())
    )
      throw new Error(`Question ${id} needs explicit instructions.`);
    const c = q.criteria;
    if (q.type === "choice") {
      if (
        !object(c) ||
        Object.keys(c).length < 1 ||
        Object.keys(c).length > 255 ||
        Object.entries(c).some(([key, value]) => !key.trim() || !isDescription(value))
      ) {
        throw new Error(`Choice ${id} needs 1–255 named options with descriptions or null.`);
      }
    } else if (q.type === "score") {
      if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every(isDescription)) {
        throw new Error(`Score ${id} needs 2–10 descriptive levels.`);
      }
    } else if (q.type === "noul") {
      if (
        c !== undefined &&
        (!object(c) ||
          Object.entries(c).some(
            ([key, value]) => !["true", "false"].includes(key) || !isDescription(value),
          ))
      ) {
        throw new Error(`Noul ${id} criteria must describe true and/or false.`);
      }
    } else throw new Error(`Unknown question type for ${id}.`);
  }
}

async function buildState(
  params: JevEvaluateInput,
  cwd: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (params.state === undefined && !params.stateFiles?.length)
    throw new Error("Provide state or stateFiles.");
  const files: JsonObject = Object.create(null);
  const state = { ...(params.state !== undefined ? { input: params.state } : {}), files };
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
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`Source is not valid UTF-8 text: ${path}`);
    }
    if (text.includes("\0")) throw new Error(`Source contains binary data: ${path}`);
    // Keep original line endings inside excerpts; a final newline does not add a phantom line.
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
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
        ? text
        : lines
            .slice(startLine - 1, endLine)
            .join("")
            .replace(/\r?\n$/, "");
    files[source.name] = { path, startLine, endLine, text: excerpt };
    if (Buffer.byteLength(JSON.stringify(state)) > MAX_REQUEST_BYTES)
      throw new Error(
        "Evidence exceeds the 192 KB local request limit; select smaller file ranges.",
      );
  }
  return state;
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function sameKeys(value: JsonObject, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateResponse(value: unknown, questions: JevEvaluateInput["questions"]): JevResponse {
  const invalid = () => {
    throw new Error("Jev returned an invalid or incomplete response.");
  };
  if (
    !object(value) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !object(value.answers) ||
    !sameKeys(value.answers, Object.keys(questions)) ||
    !object(value.usage) ||
    ![value.usage.input_tokens, value.usage.output_tokens].every(
      (n) => Number.isSafeInteger(n) && (n as number) >= 0,
    )
  )
    return invalid();
  for (const [id, q] of Object.entries(questions)) {
    const a = value.answers[id];
    if (!object(a) || a.type !== q.type) return invalid();
    if (q.type === "noul") {
      if (!probability(a.noul)) return invalid();
      continue;
    }
    const keys =
      q.type === "choice"
        ? Object.keys(q.criteria as JsonObject)
        : (q.criteria as unknown[]).map((_, i) => String(i));
    if (!probability(a.confidence) || !object(a.probabilities) || !sameKeys(a.probabilities, keys))
      return invalid();
    const probabilities = Object.values(a.probabilities);
    if (
      !probabilities.every(probability) ||
      Math.abs(probabilities.reduce((sum, p) => sum + p, 0) - 1) > 0.01
    )
      return invalid();
    if (q.type === "choice") {
      if (typeof a.choice !== "string" || !keys.includes(a.choice)) return invalid();
    } else if (
      typeof a.score !== "number" ||
      !Number.isFinite(a.score) ||
      a.score < 0 ||
      a.score > keys.length - 1 ||
      !object(a.legend) ||
      !sameKeys(a.legend, keys)
    )
      return invalid();
  }
  return value as JevResponse;
}

async function evaluate(body: string, key: string, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        redirect: "error",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal,
      });
    } catch {
      signal.throwIfAborted();
      if (attempt >= 2) throw new Error("Cannot connect to TypeSafe after 3 attempts.");
      await delay(500 * 2 ** attempt, undefined, { signal });
      continue;
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        signal.throwIfAborted();
        throw new Error("Jev returned invalid JSON.");
      }
    }
    await response.body?.cancel();
    if (attempt >= 2 || (![408, 429].includes(response.status) && response.status < 500)) {
      const hint =
        response.status === 401
          ? " Check TYPESAFE_API_KEY."
          : response.status === 422
            ? " Check questions and context limits."
            : "";
      throw new Error(`TypeSafe request failed (HTTP ${response.status}).${hint}`);
    }
    const retryAfter = response.headers.get("retry-after");
    const waitMs =
      retryAfter === null
        ? NaN
        : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now();
    await delay(
      Number.isFinite(waitMs) ? Math.min(TIMEOUT_MS, Math.max(0, waitMs)) : 500 * 2 ** attempt,
      undefined,
      { signal },
    );
  }
}

export default function registerJev(pi: ExtensionAPI): void {
  pi.registerTool<typeof parameters, Details | undefined>({
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description:
      "Evaluate supplied evidence against a batch of narrow Choice, Score and Noul questions. Returns raw typed answers and probabilities, not explanations. Reference inline evidence as input and file excerpts as files.<name>.text in instructions. Supply state, stateFiles, or both. Files must be UTF-8, at most 8 MB each; ranges are 1-indexed and inclusive. Local request limit: 192 KB; API token limits also apply. Results over 50 KB or 2000 lines are saved as complete JSON with a file pointer.",
    promptSnippet: "Make batched semantic judgments against supplied evidence using Jev",
    promptGuidelines: [
      "Use jev_evaluate when classification, candidate ranking or evidence checks benefit from narrow semantic judgments. Supply relevant original evidence and explicit criteria; use code for counting, exact lookups and execution.",
      "Batch independent jev_evaluate questions over shared evidence. Each question needs complete instructions; it sees state only. Make a second request when an earlier answer is needed to obtain evidence or construct the next question.",
      "For jev_evaluate, use Choice for competing options (include no-match when applicable), Noul for a yes/no condition or each independent label, and per-item Score for graded ranking with concrete, comparable levels.",
      "Interpret jev_evaluate uncertainty per task: Choice/Score confidence measures distribution concentration; Noul is the probability of yes. Escalate uncertain evidence checks to source inspection or reasoning, and evaluate decision thresholds on representative data.",
    ],
    parameters,
    async execute(_id, params, signal, onUpdate, ctx) {
      const started = Date.now();
      const deadline = AbortSignal.timeout(TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      combined.throwIfAborted();
      const key = process.env.TYPESAFE_API_KEY?.trim();
      if (!key) throw new Error("Set TYPESAFE_API_KEY before calling jev_evaluate.");
      validateQuestions(params.questions);
      const state = await buildState(params, ctx.cwd, combined);
      const body = JSON.stringify({
        state,
        model: "jev-latest",
        questions: params.questions,
      });
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
        throw new Error(
          "Jev request exceeds the 192 KB local limit; select smaller evidence ranges or split the batch.",
        );
      onUpdate?.({
        content: [{ type: "text", text: "Evaluating with Jev..." }],
        details: undefined,
      });
      const response = validateResponse(await evaluate(body, key, combined), params.questions);
      combined.throwIfAborted();
      const details: Details = { response, elapsedMs: Date.now() - started };
      const full = JSON.stringify({ ...response, elapsedMs: details.elapsedMs });
      let text = full;
      if (truncateHead(full).truncated) {
        // Retain the file for resumed sessions; the OS manages its temporary lifetime.
        const dir = await mkdtemp(join(tmpdir(), "pi-jev-"));
        details.outputPath = join(dir, "response.json");
        await writeFile(details.outputPath, full, { mode: 0o600, signal: combined });
        text = JSON.stringify({
          model: response.model,
          questionCount: Object.keys(response.answers).length,
          usage: response.usage,
          elapsedMs: details.elapsedMs,
          outputPath: details.outputPath,
          note: "Full response exceeds the display limit. Read outputPath for all answers and probabilities.",
        });
      }
      return { content: [{ type: "text", text }], details };
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
      const text = result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (context.isError) return new Text(theme.fg("error", text), 0, 0);
      if (isPartial) return new Text(theme.fg("warning", "Evaluating with Jev..."), 0, 0);
      if (expanded || !result.details) return new Text(theme.fg("toolOutput", text), 0, 0);
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
