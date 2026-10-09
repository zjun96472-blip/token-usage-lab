import { useQuery } from "@tanstack/react-query";
import { usageRequest } from "@/lib/api/usage";
import { resolveUsageRange } from "@/lib/usageRange";
import type {
  DailyStats,
  LogFilters,
  ModelStats,
  PaginatedLogs,
  ProviderStats,
  UsageRangeSelection,
  UsageScopeFilters,
  UsageSummaryByApp,
} from "@/types/usage";

type Options = { refetchInterval?: number | false };
function useStats<T>(
  command: string,
  range: UsageRangeSelection,
  filters: UsageScopeFilters,
  options: Options,
) {
  return useQuery({
    queryKey: ["usage", command, range, filters],
    queryFn: () =>
      usageRequest<T>(command, { ...resolveUsageRange(range), ...filters }),
    ...options,
  });
}
export const useUsageSummaryByApp = (
  range: UsageRangeSelection,
  filters: UsageScopeFilters = {},
  options: Options = {},
) =>
  useStats<UsageSummaryByApp[]>(
    "get_usage_summary_by_app",
    range,
    filters,
    options,
  );
export const useUsageTrends = (
  range: UsageRangeSelection,
  filters: UsageScopeFilters = {},
  options: Options = {},
) => useStats<DailyStats[]>("get_usage_trends", range, filters, options);
export const useModelStats = (
  range: UsageRangeSelection,
  filters: UsageScopeFilters = {},
  options: Options = {},
) => useStats<ModelStats[]>("get_model_stats", range, filters, options);
export const useProviderStats = (
  range: UsageRangeSelection,
  filters: UsageScopeFilters = {},
  options: Options = {},
) => useStats<ProviderStats[]>("get_provider_stats", range, filters, options);

export function useRequestLogs({
  filters,
  page,
  pageSize,
  range,
  options = {},
}: {
  filters: LogFilters;
  page: number;
  pageSize: number;
  range: UsageRangeSelection;
  options?: Options;
}) {
  return useQuery({
    queryKey: ["usage", "get_request_logs", filters, page, pageSize, range],
    queryFn: () =>
      usageRequest<PaginatedLogs>("get_request_logs", {
        filters: { ...filters, ...resolveUsageRange(range) },
        page,
        pageSize,
      }),
    ...options,
  });
}
