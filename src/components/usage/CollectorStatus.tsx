import {
  CheckCircle2,
  CircleDashed,
  ListFilter,
  TriangleAlert,
} from "lucide-react";
import {
  SOURCE_NAMES,
  SOURCE_IDS,
  SOURCE_PATHS,
  SOURCE_LIMITS,
  FIXTURE_ONLY,
  PENDING_SOURCES,
  STATE_NAMES,
  type SourceStatus,
} from "@/types/collector";
import { fmtInt } from "./format";

export function SourceStrip({
  sources,
  loading = false,
  onSelect,
}: {
  sources: SourceStatus[];
  loading?: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="source-strip">
      {SOURCE_IDS.map((id) => {
        const source = sources.find((row) => row.source === id);
        const Icon =
          !source || source.state === "missing"
            ? CircleDashed
            : source.state === "ready"
              ? CheckCircle2
              : TriangleAlert;
        return (
          <button
            key={id}
            type="button"
            onClick={onSelect}
            className={`source-state ${source?.state ?? "missing"}`}
          >
            <Icon size={15} />
            <strong>{SOURCE_NAMES[id]}</strong>
            <span>
              {source
                ? STATE_NAMES[source.state]
                : loading
                  ? "读取中"
                  : "未扫描"}
            </span>
            {FIXTURE_ONLY.includes(id) && <small>实机未验收</small>}
          </button>
        );
      })}
      <button className="source-state" onClick={onSelect} type="button">
        <ListFilter size={15} />
        <strong>工具覆盖清单</strong>
        <span>{SOURCE_IDS.length} 个采集器</span>
      </button>
    </div>
  );
}

export function CollectorStatus({
  sources,
  loading = false,
}: {
  sources: SourceStatus[];
  loading?: boolean;
}) {
  return (
    <div className="collector-list">
      <div className="coverage-heading">
        <h3>已接入来源</h3>
        <span>{SOURCE_IDS.length} 个采集器 · 默认日志目录</span>
      </div>
      {SOURCE_IDS.map((id) => {
        const source = sources.find((row) => row.source === id);
        return (
          <section className="collector" key={id}>
            <div className="collector-heading">
              <h3>{SOURCE_NAMES[id]}</h3>
              <span>
                {source
                  ? STATE_NAMES[source.state]
                  : loading
                    ? "读取中"
                    : "未扫描"}
              </span>
            </div>
            <dl className="status-grid">
              <div>
                <dt>日志目录</dt>
                <dd>{SOURCE_PATHS[id]}</dd>
              </div>
              <div>
                <dt>验收范围</dt>
                <dd>
                  {FIXTURE_ONLY.includes(id)
                    ? "合成样本 · 实机未验收"
                    : "本机日志格式"}
                </dd>
              </div>
              {SOURCE_LIMITS[id] && (
                <div>
                  <dt>格式范围</dt>
                  <dd>{SOURCE_LIMITS[id]}</dd>
                </div>
              )}
              <div>
                <dt>历史已采集调用</dt>
                <dd>
                  {source?.observedRequests
                    ? fmtInt(source.observedRequests)
                    : "未覆盖"}
                </dd>
              </div>
              <div>
                <dt>扫描文件</dt>
                <dd>{source ? fmtInt(source.filesScanned) : "未知"}</dd>
              </div>
              <div>
                <dt>本轮新增 / 更新</dt>
                <dd>
                  {source ? `${source.imported} / ${source.updated}` : "未知"}
                </dd>
              </div>
              <div>
                <dt>未提供用量的记录</dt>
                <dd>{source ? source.unmetered : "未知"}</dd>
              </div>
              <div>
                <dt>不支持 / 损坏记录</dt>
                <dd>
                  {source
                    ? `${source.unsupported} / ${source.malformed}`
                    : "未知"}
                </dd>
              </div>
              <div>
                <dt>待写完 / 读取失败文件</dt>
                <dd>
                  {source
                    ? `${source.deferredFiles} / ${source.fileErrors}`
                    : "未知"}
                </dd>
              </div>
              <div>
                <dt>最近扫描</dt>
                <dd>
                  {source
                    ? new Date(source.lastScanAt).toLocaleString("zh-CN", {
                        hour12: false,
                      })
                    : "尚未扫描"}
                </dd>
              </div>
              <div>
                <dt>实际发起人</dt>
                <dd>未归因</dd>
              </div>
            </dl>
          </section>
        );
      })}
      <div className="coverage-heading">
        <h3>尚未覆盖</h3>
        <span>Token 未知 · 不计入总量</span>
      </div>
      <div className="coverage-table-wrap">
        <table className="coverage-table" aria-label="尚未覆盖的工具">
          <thead>
            <tr>
              <th>工具</th>
              <th>候选数据来源</th>
              <th>接入状态</th>
            </tr>
          </thead>
          <tbody>
            {PENDING_SOURCES.map((source) => (
              <tr key={source.name}>
                <td>{source.name}</td>
                <td>{source.route}</td>
                <td>{source.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
