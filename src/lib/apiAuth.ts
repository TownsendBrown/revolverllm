const STORAGE_KEY = "revolver-api-key";

export function getStoredApiKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredApiKey(key: string): void {
  sessionStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearStoredApiKey(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function apiAuthHeaders(): Record<string, string> {
  const key = getStoredApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

export async function fetchWithAuth(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = apiAuthHeaders();
  for (const [k, v] of Object.entries(auth)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401 && !getStoredApiKey()) {
    const pasted = window.prompt("Revolver API key required (Bearer token):");
    if (pasted?.trim()) {
      setStoredApiKey(pasted);
      return fetchWithAuth(input, init);
    }
  }
  return res;
}
