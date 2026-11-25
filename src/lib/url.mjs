// The OpenAI-compatible base is the one with /v1 on it. A client appends the operation path (`/chat/completions`)
// to whatever it is given, so a bare host answers a 404 that says nothing about the missing segment — which cost an
// hour once, on a device that reports only `{"detail":"Not Found"}`.

export function normaliseBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
