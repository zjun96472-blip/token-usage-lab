import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { aggregateSummaries, UsageHero } from "@/components/usage/UsageHero";
import { buildUsageTrendChartData } from "@/components/usage/UsageTrendChart";
import {
  CollectorStatus,
  SourceStrip,
} from "@/components/usage/CollectorStatus";
import { fmtUsd } from "@/components/usage/format";
import {
  getFreshInputTokens,
  isUnpricedUsage,
  type UsageSummary,
} from "@/types/usage";
import { resolveUsageRange } from "@/lib/usageRange";
import { SOURCE_IDS, FIXTURE_ONLY } from "@/types/collector";

const query = vi.hoisted(() => ({
  data: [] as unknown[],
  isLoading: false,
  isError: false,
}));
vi.mock("@/lib/query/usage", () => ({
  useUsageSummaryByApp: () => query,
  useUsageTrends: () => query,
}));

const summary: UsageSummary = {
  totalRequests: 1,
  totalCost: null,
  totalInputTokens: 40,
  totalOutputTokens: 20,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 60,
  realTotalTokens: 120,
  cacheHitRate: 0.6,
  successRate: null,
};

describe("reported usage semantics", () => {
  it("sums the four disjoint buckets without adding cache twice", () => {
    const value = aggregateSummaries([summary, summary]);
    expect(value.realTotalTokens).toBe(240);
    expect(value.totalRequests).toBe(2);
    expect(value.cacheHitRate).toBe(0.6);
    expect(value.totalCost).toBeNull();
    expect(
      getFreshInputTokens({
        appType: "workbuddy",
        inputTokens: 40,
        cacheReadTokens: 60,
      }),
    ).toBe(40);
  });
  it("does not turn unknown cost into a zero dollar bill", () => {
    expect(fmtUsd(null, 2)).toBe("未知");
    expect(
      isUnpricedUsage({
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        totalCostUsd: null,
        statusCode: 0,
      }),
    ).toBe(true);
    expect(aggregateSummaries([]).totalCost).toBeNull();
    expect(
      aggregateSummaries([summary, { ...summary, totalCost: "1.2" }]).totalCost,
    ).toBeNull();
  });
  it("does not deduct cache again in already normalized Codex and Gemini details", () => {
    for (const appType of ["codex", "gemini", "opencode", "kilo"]) {
      expect(
        getFreshInputTokens({ appType, inputTokens: 100, cacheReadTokens: 20 }),
      ).toBe(100);
    }
  });
  it("renders exact observed totals and missing sources distinctly", () => {
    query.data = [{ appType: "workbuddy", summary }];
    const { rerender } = render(
      <UsageHero
        range={{ preset: "all" }}
        appType="workbuddy"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent("120");
    expect(screen.getByTestId("metric-缓存写入")).toHaveTextContent("0");
    expect(screen.getByTestId("metric-参考费用")).toHaveTextContent("未知");
    rerender(
      <UsageHero
        range={{ preset: "all" }}
        appType="openclaw"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent(
      "未覆盖",
    );
    expect(screen.getByTestId("metric-缓存写入")).toHaveTextContent("未覆盖");
  });
  it("does not show zero for failed queries", () => {
    query.data = [];
    query.isError = true;
    render(<UsageHero range={{ preset: "all" }} refreshIntervalMs={0} />);
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent(
      "不可用",
    );
    query.isError = false;
  });
  it("retains last known totals when a background read fails", () => {
    query.data = [{ appType: "workbuddy", summary }];
    query.isError = true;
    render(<UsageHero range={{ preset: "all" }} refreshIntervalMs={0} />);
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent("120");
    query.isError = false;
  });
  it("distinguishes source status loading from an unscanned ledger", () => {
    render(<SourceStrip sources={[]} loading onSelect={() => {}} />);
    expect(screen.getAllByText("读取中")).toHaveLength(SOURCE_IDS.length);
    expect(screen.queryByText("未扫描")).not.toBeInTheDocument();
  });
  it("keeps reported totals while displaying an unavailable cache split as unknown", () => {
    query.data = [
      {
        appType: "qwen",
        summary: { ...summary, inputBreakdownComplete: false },
      },
    ];
    render(
      <UsageHero
        range={{ preset: "all" }}
        appType="qwen"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent("120");
    expect(screen.getByTestId("metric-新增输入")).toHaveTextContent("未知");
    expect(screen.getByTestId("metric-缓存写入")).toHaveTextContent("未知");
    expect(screen.getByTestId("metric-缓存命中")).toHaveTextContent("60");
    expect(
      aggregateSummaries([
        summary,
        { ...summary, inputBreakdownComplete: false },
      ]).inputBreakdownComplete,
    ).toBe(false);
  });
  it("fits large lifetime totals without breaking the number across lines", () => {
    query.data = [
      {
        appType: "codex",
        summary: {
          ...summary,
          totalInputTokens: 43000000000,
          realTotalTokens: 43000000080,
        },
      },
    ];
    render(<UsageHero range={{ preset: "all" }} refreshIntervalMs={0} />);
    expect(screen.getByTestId("metric-已采集 Token")).toHaveStyle({
      fontSize: "18px",
    });
    expect(screen.getByTestId("metric-已采集 Token")).toHaveTextContent(
      "43,000,000,080",
    );
  });
  it("reconciles trend totals and keeps costs null", () => {
    const points = buildUsageTrendChartData(
      [
        {
          date: "2026-10-01T00:00:00+08:00",
          requestCount: 1,
          totalInputTokens: 40,
          totalOutputTokens: 20,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 60,
          totalCost: null,
        },
      ],
      {
        isHourly: false,
        dateLocale: "zh-CN",
        startDate: 0,
        endDate: 1791400000,
      },
    );
    expect(points[0].tokens).toBe(120);
    expect(points[0].cost).toBeNull();
  });
  it("keeps real OpenClaw validation explicitly unaccepted", () => {
    render(<SourceStrip sources={[]} onSelect={() => {}} />);
    expect(screen.getAllByText("实机未验收")).toHaveLength(FIXTURE_ONLY.length);
    render(<CollectorStatus sources={[]} />);
    expect(screen.getAllByText("合成样本 · 实机未验收")).toHaveLength(
      FIXTURE_ONLY.length,
    );
  });
  it("distinguishes installed adapters from unconnected market tools", () => {
    expect(SOURCE_IDS).toEqual([
      "workbuddy",
      "openclaw",
      "codex",
      "claude",
      "gemini",
      "pi",
      "opencode",
      "kilo",
      "qwen",
    ]);
    render(<CollectorStatus sources={[]} />);
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Claude Code" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("table", { name: "尚未覆盖的工具" }),
    ).toHaveTextContent("Cursor");
    expect(
      screen.getByRole("table", { name: "尚未覆盖的工具" }),
    ).toHaveTextContent("GitHub Copilot");
    expect(screen.getByText("Token 未知 · 不计入总量")).toBeInTheDocument();
    for (const name of ["OpenCode", "Kilo Code", "Qwen Code"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(
      screen.getByText("新版 SQLite；旧版 VS Code 任务日志未覆盖"),
    ).toBeInTheDocument();
  });
  it("keeps the all-time summary unbounded and honors custom dates", () => {
    expect(resolveUsageRange({ preset: "all" }, 1000000)).toEqual({
      startDate: 0,
      endDate: 1000,
    });
    expect(
      resolveUsageRange(
        { preset: "custom", customStartDate: 50, customEndDate: 200 },
        1000000,
      ),
    ).toEqual({ startDate: 50, endDate: 200 });
  });
});
