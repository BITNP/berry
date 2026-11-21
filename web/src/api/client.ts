let csrfTokenCache = "";

export function setCsrfToken(token: string): void {
  csrfTokenCache = token;
}

async function ensureCsrfToken(): Promise<string> {
  if (csrfTokenCache) {
    return csrfTokenCache;
  }

  const res = await fetch("/api/auth/csrf", { credentials: "same-origin" });

  if (res.ok) {
    const data = (await res.json()) as { token?: string };

    if (data.token) {
      csrfTokenCache = data.token;
    }
  }

  return csrfTokenCache;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = await ensureCsrfToken();

    if (token) {
      headers.set("X-CSRF-Token", token);
    }
  }

  const res = await fetch(path, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  let parsed: unknown = null;

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { message: text };
    }
  }

  if (!res.ok) {
    const rawMsg =
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string"
        ? (parsed as { message: string }).message
        : "";
    const msg = rawMsg || `请求失败 (HTTP ${res.status})`;

    throw new Error(msg);
  }

  return parsed as T;
}
