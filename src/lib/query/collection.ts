import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usageRequest } from "@/lib/api/usage";
import { SOURCE_IDS, type SourceStatus } from "@/types/collector";

const SOURCE_KEY = ["usage", "sources"] as const;
const INTERVAL_MS = 60000;

export function hasRecentScan(
  sources: SourceStatus[] | undefined,
  now = Date.now(),
) {
  return SOURCE_IDS.every((id) => {
    const source = sources?.find((item) => item.source === id);
    return (
      source &&
      source.state !== "error" &&
      Number.isFinite(source.lastScanAt) &&
      source.lastScanAt > 0 &&
      source.lastScanAt <= now &&
      now - source.lastScanAt < INTERVAL_MS
    );
  });
}

export function useUsageCollection() {
  const client = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const [syncFailed, setSyncFailed] = useState(false);
  const busy = useRef(false);
  const started = useRef(false);
  const mounted = useRef(false);
  const status = useQuery({
    queryKey: SOURCE_KEY,
    queryFn: () => usageRequest<SourceStatus[]>("get_source_status"),
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    if (mounted.current) {
      setSyncing(true);
      setSyncFailed(false);
    }
    try {
      const result = await usageRequest<{ sources: SourceStatus[] }>(
        "sync_session_usage",
      );
      client.setQueryData(SOURCE_KEY, result.sources);
      // Sync already returns source status. Keep loaded statistics during their background reads.
      await client.invalidateQueries({
        queryKey: ["usage"],
        predicate: (query) => query.queryKey[1] !== "sources",
      });
    } catch {
      if (mounted.current) setSyncFailed(true);
    } finally {
      busy.current = false;
      if (mounted.current) setSyncing(false);
    }
  }, [client]);

  useEffect(() => {
    if (status.isPending || started.current) return;
    // Make the startup decision once, including under StrictMode effect replay.
    started.current = true;
    if (!hasRecentScan(status.data)) void refresh();
  }, [status.isPending, status.data, refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return {
    sources: status.data ?? [],
    sourcesLoading: status.isPending,
    syncing,
    syncFailed,
    refresh,
  };
}
