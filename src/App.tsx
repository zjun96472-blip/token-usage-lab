import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Activity, RefreshCw, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UsageHero } from "@/components/usage/UsageHero";
import { UsageTrendChart } from "@/components/usage/UsageTrendChart";
import { UsageDateRangePicker } from "@/components/usage/UsageDateRangePicker";
import { RequestLogTable } from "@/components/usage/RequestLogTable";
import { ModelStatsTable } from "@/components/usage/ModelStatsTable";
import { ProviderStatsTable } from "@/components/usage/ProviderStatsTable";
import {
  CollectorStatus,
  SourceStrip,
} from "@/components/usage/CollectorStatus";
import { UsageDetail } from "@/components/usage/UsageDetail";
import { HoverTip } from "@/components/ui/hover-tip";
import { Button } from "@/components/ui/button";
import { useModelStats } from "@/lib/query/usage";
import { useUsageCollection } from "@/lib/query/collection";
import { getUsageRangePresetLabel } from "@/lib/usageRange";
import type { UsageRangeSelection } from "@/types/usage";
import { SOURCE_IDS, SOURCE_NAMES } from "@/types/collector";

const TABS = [
  ["logs", "调用明细"],
  ["models", "模型统计"],
  ["sources", "来源统计"],
  ["status", "采集状态"],
] as const;
type Tab = (typeof TABS)[number][0];

export default function App() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [range, setRange] = useState<UsageRangeSelection>({ preset: "all" });
  const [appType, setAppType] = useState("");
  const [model, setModel] = useState("");
  const [tab, setTab] = useState<Tab>("logs");
  const [detail, setDetail] = useState<string | null>(null);
  const [queryFailed, setQueryFailed] = useState(false);
  const { sources, sourcesLoading, syncing, syncFailed, refresh } =
    useUsageCollection();
  const { data: models = [] } = useModelStats(range, {
    appType: appType || undefined,
  });
  useEffect(
    () =>
      client.getQueryCache().subscribe(() => {
        setQueryFailed(
          client
            .getQueryCache()
            .findAll({ queryKey: ["usage"], type: "active" })
            .some((query) => query.state.status === "error"),
        );
      }),
    [client],
  );
  const scope = {
    range,
    appType: appType || undefined,
    model: model || undefined,
    refreshIntervalMs: 0,
  };
  const rangeLabel = getUsageRangePresetLabel(range.preset, t);
  const lastScan = Math.max(0, ...sources.map((source) => source.lastScanAt));
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Activity size={24} />
          <h1>Token Usage Lab</h1>
          <span className="version">0.1</span>
        </div>
        <span className="scope-label">
          <ShieldCheck size={15} />
          本机 · 当前系统用户
        </span>
      </header>
      <main>
        <div className="page-heading">
          <h2>用量统计</h2>
          <span>
            日志报告值<span className="divider">/</span>实际账单：未接入
          </span>
        </div>
        <SourceStrip
          sources={sources}
          loading={sourcesLoading}
          onSelect={() => setTab("status")}
        />
        <div className="toolbar">
          <label className="filter">
            <span>来源</span>
            <select
              aria-label="来源筛选"
              value={appType}
              onChange={(event) => {
                setAppType(event.target.value);
                setModel("");
              }}
            >
              <option value="">全部来源</option>
              {SOURCE_IDS.map((id) => (
                <option key={id} value={id}>
                  {SOURCE_NAMES[id]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter model-filter">
            <span>模型</span>
            <select
              aria-label="模型筛选"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">全部模型</option>
              {models.map((row) => (
                <option key={row.model} value={row.model}>
                  {row.model}
                </option>
              ))}
            </select>
          </label>
          <div className="toolbar-end">
            <UsageDateRangePicker
              selection={range}
              onApply={(next) => {
                setRange(next);
                setModel("");
              }}
              triggerLabel={rangeLabel}
            />
            <HoverTip content="重新采集">
              <Button
                variant="neutral"
                size="icon"
                aria-label="重新采集"
                disabled={syncing}
                onClick={() => void refresh()}
              >
                <RefreshCw
                  size={15}
                  className={syncing ? "animate-spin" : ""}
                />
              </Button>
            </HoverTip>
          </div>
        </div>
        {(syncFailed || queryFailed) && (
          <div className="error-banner" role="alert">
            本地统计读取失败，当前数据可能不是最新状态。
            <Button variant="quiet" onClick={() => void refresh()}>
              重试
            </Button>
          </div>
        )}
        <UsageHero {...scope} />
        <UsageTrendChart {...scope} rangeLabel={rangeLabel} />
        <div className="tab-bar" role="tablist" aria-label="统计视图">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              id={`tab-${id}`}
              aria-controls="statistics-panel"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <section
          id="statistics-panel"
          role="tabpanel"
          aria-labelledby={`tab-${tab}`}
          className="statistics-panel"
        >
          {tab === "logs" && (
            <RequestLogTable {...scope} onOpenDetail={setDetail} />
          )}
          {tab === "models" && <ModelStatsTable {...scope} />}
          {tab === "sources" && <ProviderStatsTable {...scope} />}
          {tab === "status" && (
            <CollectorStatus sources={sources} loading={sourcesLoading} />
          )}
        </section>
        <footer>
          <span>
            {syncing
              ? "采集中..."
              : lastScan
                ? `最近采集 ${new Date(lastScan).toLocaleTimeString("zh-CN", { hour12: false })}`
                : sourcesLoading
                  ? "读取中..."
                  : "尚未采集"}
          </span>
          <span>本地账本 · 发起人未归因</span>
        </footer>
      </main>
      <UsageDetail id={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
