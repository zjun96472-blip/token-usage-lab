import { StrictMode, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usageRequest } from "@/lib/api/usage";
import { hasRecentScan, useUsageCollection } from "@/lib/query/collection";
import { useUsageTrends } from "@/lib/query/usage";
import { SOURCE_IDS, type SourceStatus } from "@/types/collector";
import { usageTable } from "@/components/usage/usageTable";

vi.mock("@/lib/api/usage", () => ({ usageRequest: vi.fn() }));
const request = vi.mocked(usageRequest);
const clients: QueryClient[] = [];
const NOW = 1791500000000;

function statuses(time = NOW): SourceStatus[] {
  return SOURCE_IDS.map((source) => ({
    source,
    state: "missing",
    filesScanned: 0,
    observedRequests: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    malformed: 0,
    unsupported: 0,
    unmetered: 0,
    deferredFiles: 0,
    fileErrors: 0,
    lastScanAt: time,
    validation: "fixtures-only",
  }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 30000,
        refetchOnWindowFocus: false,
      },
    },
  });
  clients.push(client);
  function wrapper({ children }: PropsWithChildren) {
    return (
      <StrictMode>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </StrictMode>
    );
  }
  return { client, wrapper };
}
const calls = (command: string) =>
  request.mock.calls.filter(([name]) => name === command).length;
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  request.mockReset();
  request.mockImplementation(async (command) => {
    if (command === "get_source_status") return statuses();
    if (command === "sync_session_usage")
      return { sources: statuses(Date.now()) };
    return [];
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
});

describe("quiet collection lifecycle", () => {
  it("only treats complete, valid and recent scan status as fresh", () => {
    expect(hasRecentScan(statuses())).toBe(true);
    expect(hasRecentScan(undefined)).toBe(false);
    expect(hasRecentScan(statuses().slice(1))).toBe(false);
    for (const time of [0, NaN, NOW + 1, NOW - 60000]) {
      const data = statuses();
      data[0].lastScanAt = time;
      expect(hasRecentScan(data)).toBe(false);
    }
    const failed = statuses();
    failed[0].state = "error";
    expect(hasRecentScan(failed)).toBe(false);
  });

  it("waits for persisted status and skips a redundant startup scan", async () => {
    const pending = deferred<SourceStatus[]>();
    request.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(useUsageCollection, setup());
    await settle();
    expect(result.current.sourcesLoading).toBe(true);
    expect(calls("sync_session_usage")).toBe(0);
    pending.resolve(statuses());
    await settle();
    expect(result.current.sourcesLoading).toBe(false);
    expect(calls("get_source_status")).toBe(1);
    expect(calls("sync_session_usage")).toBe(0);
  });

  it("scans stale status once under StrictMode and reuses returned source status", async () => {
    const pending = deferred<{ sources: SourceStatus[] }>();
    request.mockImplementation(async (command) => {
      if (command === "get_source_status") return statuses(NOW - 61000);
      if (command === "sync_session_usage") return pending.promise;
      return [];
    });
    const { client, wrapper } = setup();
    const { result } = renderHook(
      () => ({
        collection: useUsageCollection(),
        trends: useUsageTrends({ preset: "all" }),
      }),
      { wrapper },
    );
    await settle();
    expect(calls("sync_session_usage")).toBe(1);
    expect(result.current.collection.syncing).toBe(true);
    await act(async () => {
      await result.current.collection.refresh();
    });
    expect(calls("sync_session_usage")).toBe(1);
    const fresh = statuses(Date.now());
    pending.resolve({ sources: fresh });
    await settle();
    expect(result.current.collection.syncing).toBe(false);
    expect(client.getQueryData(["usage", "sources"])).toEqual(fresh);
    expect(calls("get_source_status")).toBe(1);
    expect(calls("get_usage_trends")).toBe(2);
    expect(calls("sync_session_usage")).toBe(1);
  });

  it("preserves loaded data during refresh and does not reuse it for another filter", async () => {
    const pending = deferred<unknown[]>();
    const before = [{ date: "2026-10-01", totalInputTokens: 12 }];
    request.mockImplementation(async (command) => {
      if (command === "get_source_status") return statuses();
      if (command === "sync_session_usage")
        return { sources: statuses(Date.now()) };
      return calls(command) === 1 ? before : pending.promise;
    });
    const { result, rerender } = renderHook(
      ({ appType }) => ({
        collection: useUsageCollection(),
        trends: useUsageTrends({ preset: "all" }, { appType }),
      }),
      { ...setup(), initialProps: { appType: "workbuddy" } },
    );
    await settle();
    act(() => {
      void result.current.collection.refresh();
    });
    await settle();
    expect(result.current.trends.isFetching).toBe(true);
    expect(result.current.trends.isLoading).toBe(false);
    expect(result.current.trends.data).toEqual(before);
    rerender({ appType: "codex" });
    expect(result.current.trends.isLoading).toBe(true);
    expect(result.current.trends.data).toBeUndefined();
    pending.resolve([]);
    await settle();
  });

  it("keeps last known status on failure and permits a manual retry", async () => {
    const { result } = renderHook(useUsageCollection, setup());
    await settle();
    const previous = result.current.sources;
    request.mockRejectedValueOnce(new Error("service unavailable"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.syncFailed).toBe(true);
    expect(result.current.syncing).toBe(false);
    expect(result.current.sources).toEqual(previous);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.syncFailed).toBe(false);
    expect(calls("sync_session_usage")).toBe(2);
  });

  it("recovers a failed initial source read through the sync response", async () => {
    request.mockRejectedValueOnce(new Error("read failed"));
    const { result, rerender } = renderHook(useUsageCollection, setup());
    await settle();
    rerender();
    await settle();
    expect(result.current.sources).toHaveLength(SOURCE_IDS.length);
    expect(result.current.syncFailed).toBe(false);
    expect(calls("sync_session_usage")).toBe(1);
    expect(calls("get_source_status")).toBe(1);
  });

  it("keeps periodic collection single and removes the timer on unmount", async () => {
    const { unmount } = renderHook(useUsageCollection, setup());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(calls("sync_session_usage")).toBe(1);
    expect(calls("get_source_status")).toBe(1);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    expect(calls("sync_session_usage")).toBe(1);
  });

  it("does not loop when a scan returns incomplete or still-stale source status", async () => {
    request.mockImplementation(async (command) =>
      command === "get_source_status"
        ? []
        : { sources: statuses(NOW - 120000) },
    );
    renderHook(useUsageCollection, setup());
    await settle();
    await settle();
    expect(calls("sync_session_usage")).toBe(1);
  });

  it("does not pulse the large initial table placeholder", () => {
    expect(usageTable.skeleton).not.toContain("animate-");
  });
});
