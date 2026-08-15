export function buildOpenAIChatCompletionsUrl(baseUrl: string): string {
    const trimmed = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!trimmed) {
        return "/v1/chat/completions";
    }
    if (trimmed.endsWith("/chat/completions")) {
        return trimmed;
    }
    return /\/v\d+$/.test(trimmed)
        ? `${trimmed}/chat/completions`
        : `${trimmed}/v1/chat/completions`;
}
