import { invoke, isTauri } from "@tauri-apps/api/core";

export async function usageRequest<T>(
  command: string,
  args: unknown = {},
): Promise<T> {
  const request = { command, args };
  if (isTauri()) return invoke<T>("usage_request", { request });
  const response = await fetch("/api/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error("Local usage service unavailable");
  return response.json();
}
