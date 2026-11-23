// The client's per-job directory: a copy of the shared cache, plus the model entry and the settings for this run.
//
// Never the shared cache itself — a writable shared directory is how the next run ends up loading someone else's code.

import { writeFileSync, mkdirSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function seedAgentDir() {
  const cache = process.env.PI_CODING_AGENT_DIR;
  const dir = join(process.env.RUNNER_TEMP || tmpdir(), `ai-review-agent-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  if (cache && cache !== dir && existsSync(cache)) {
    try {
      cpSync(cache, dir, { recursive: true });
    } catch (err) {
      console.error(`[ai-review] could not seed the agent dir from ${cache}: ${err.message}`);
    }
  }
  return dir;
}

export function writeAgentDir({ model, baseUrl, apiKeyEnv, settings }) {
  // Supplied by the action when the runner keeps a directory between jobs, so pi's `-e` package cache persists.
  const dir = process.env.PI_CODING_AGENT_DIR || join(tmpdir(), `ai-review-agent-${process.pid}`);
  mkdirSync(dir, { recursive: true });

  // A model with no thinking parameter gets no compatibility shim: sending reasoning_effort to a template that does not
  // read it is ignored at best. The wire format is the repo's choice — see modelSettings.thinkingFormat.
  // supportsMidConvoSystemMessages is load-bearing, not cosmetic: pi-rules injects rules as a mid-conversation system
  // message, and without this the adapter folds it into the *leading* prompt, rewriting every token after the fold and
  // dropping the prefix cache to single-digit percentages. Measured in this repo's own tooling.
  const compat = {
    ...(settings.reasoning && settings.thinkingFormat !== "none" ? { thinkingFormat: settings.thinkingFormat } : {}),
    supportsMidConvoSystemMessages: true,
  };
  const levels = { minimal: "minimal", low: "low", medium: "medium", high: "high" };

  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify(
      {
        providers: {
          local: {
            baseUrl,
            api: "openai-completions",
            apiKey: `$${apiKeyEnv}`,
            models: [
              {
                id: model,
                name: model,
                reasoning: settings.reasoning,
                input: ["text"],
                // No max_tokens is sent per request: an OpenAI-compatible server defaults to its own limit (-1 on the
                // hardware this was built against, meaning the context). maxTokens here is the client's output budget,
                // and below the size of the model's thinking it truncates a turn mid-thought and returns no tool call.
                contextWindow: settings.contextWindow,
                maxTokens: settings.maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                compat,
                samplingParams: {
                  temperature: settings.temperature,
                  top_p: settings.topP,
                  top_k: settings.topK,
                  min_p: settings.minP,
                  presence_penalty: settings.presencePenalty,
                  repeat_penalty: settings.repeatPenalty,
                  // Sent only when a deployment sets them: a server that does not know a field may reject the request,
                  // and these are for a model that loops, not for every model.
                  ...(settings.frequencyPenalty > 0 ? { frequency_penalty: settings.frequencyPenalty } : {}),
                  ...(settings.dryMultiplier > 0
                    ? {
                        dry_multiplier: settings.dryMultiplier,
                        dry_allowed_length: Math.max(1, settings.dryAllowedLength || 2),
                      }
                    : {}),
                },
                thinkingLevelMap: levels,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  // Compaction starts at a fifth of the window, so a long review summarises before the context forces it.
  // `httpIdleTimeoutMs` is the client's own patience, and its default of five minutes is shorter than a slow device needs
  // to read a large prompt: it abandons runs that were working, and the failure arrives as an upstream stream timeout
  // rather than as our timeout. `retry.provider.maxRetries` is 0 because the agent-level retry already covers a failed
  // request; both on means the same request can be retried twice over.
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify(
      {
        compaction: { enabled: true, reserveTokens: Math.round(settings.contextWindow * 0.19) },
        httpIdleTimeoutMs: settings.providerTimeoutMs > 0 ? settings.providerTimeoutMs : "disabled",
        // Five agent-level retries, stated rather than inherited: the client's default is three, and a retry policy that
        // nobody chose is a policy nobody can reason about. Provider-level stays 0 — the agent retry covers the same
        // failure, and both at once retries one request twice over.
        retry: { maxRetries: 5, provider: { maxRetries: 0 } },
      },
      null,
      2,
    ),
  );

  return dir;
}
