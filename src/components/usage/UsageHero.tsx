import { useUsageSummaryByApp } from "@/lib/query/usage";
import { fmtInt, fmtUsd } from "./format";
import type { UsageRangeSelection, UsageSummary } from "@/types/usage";

// Incomplete sources retain unsplit non-hit input for totals, but not as a known fresh/write split.
export function aggregateSummaries(items: UsageSummary[]): UsageSummary {
  const sum = (
    key:
      | "totalRequests"
      | "totalInputTokens"
      | "totalOutputTokens"
      | "totalCacheCreationTokens"
      | "totalCacheReadTokens",
  ) => items.reduce((total, row) => total + row[key], 0);
  const input = sum("totalInputTokens"),
    output = sum("totalOutputTokens");
  const read = sum("totalCacheReadTokens"),
    write = sum("totalCacheCreationTokens");
  return {
    inputBreakdownComplete: items.every(
      (row) => row.inputBreakdownComplete !== false,
    ),
    totalRequests: sum("totalRequests"),
    totalInputTokens: input,
    totalOutputTokens: output,
    totalCacheCreationTokens: write,
    totalCacheReadTokens: read,
    realTotalTokens: input + output + read + write,
    cacheHitRate: input + read + write > 0 ? read / (input + read + write) : 0,
    totalCost:
      items.length && items.every((row) => row.totalCost != null)
        ? items
            .reduce((total, row) => total + Number(row.totalCost), 0)
            .toFixed(6)
        : null,
    successRate: null,
  };
}

export function UsageHero({
  range,
  appType,
  model,
  refreshIntervalMs,
}: {
  range: UsageRangeSelection;
  appType?: string;
  model?: string;
  refreshIntervalMs: number;
}) {
  const { data, isLoading, isError } = useUsageSummaryByApp(
    range,
    { model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );
  const summaries =
    data
      ?.filter((row) => !appType || row.appType === appType)
      .map((row) => row.summary) ?? [];
  const summary = aggregateSummaries(summaries);
  const covered = summaries.length > 0 && summary.totalRequests > 0;
  const empty = isLoading ? "..." : isError ? "不可用" : "未覆盖";
  const number = (value: number, known = true) =>
    covered ? (known ? fmtInt(value, "zh-CN") : "未知") : empty;
  const metrics = [
    ["已采集 Token", number(summary.realTotalTokens)],
    ["模型调用", number(summary.totalRequests)],
    [
      "缓存命中率",
      covered &&
      summary.totalInputTokens +
        summary.totalCacheReadTokens +
        summary.totalCacheCreationTokens >
        0
        ? `${(summary.cacheHitRate * 100).toFixed(1)}%`
        : "未知",
    ],
    ["参考费用", fmtUsd(summary.totalCost, 2)],
  ];
  const tokens = [
    ["新增输入", summary.totalInputTokens, summary.inputBreakdownComplete],
    ["输出", summary.totalOutputTokens, true],
    ["缓存命中", summary.totalCacheReadTokens, true],
    [
      "缓存写入",
      summary.totalCacheCreationTokens,
      summary.inputBreakdownComplete,
    ],
  ] as const;
  return (
    <section aria-label="用量汇总" className="usage-metrics">
      <div className="metric-grid">
        {metrics.map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong
              data-testid={`metric-${label}`}
              style={{
                fontSize:
                  value.length > 17 ? 13 : value.length > 12 ? 18 : undefined,
              }}
            >
              {value}
            </strong>
          </div>
        ))}
      </div>
      <div className="token-grid">
        {tokens.map(([label, value, known]) => (
          <div key={label}>
            <span>{label}</span>
            <b data-testid={`metric-${label}`}>{number(value, known)}</b>
          </div>
        ))}
      </div>
    </section>
  );
}
