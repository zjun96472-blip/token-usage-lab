import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { usageRequest } from "@/lib/api/usage";
import type { RequestLog } from "@/types/usage";
import { fmtInt } from "./format";
import { SOURCE_NAMES, type SourceId } from "@/types/collector";

type Detail = RequestLog & {
  executionKind: string;
  actorKind: string;
  measurement: string;
};
export function UsageDetail({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["usage", "detail", id],
    enabled: id != null,
    queryFn: () =>
      usageRequest<Detail | null>("get_request_detail", { requestId: id }),
  });
  return (
    <Dialog
      open={id != null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-[min(560px,calc(100vw-32px))] overflow-y-auto p-6">
        <Button
          variant="quiet"
          size="icon"
          className="absolute right-3 top-3"
          aria-label="关闭详情"
          title="关闭详情"
          onClick={onClose}
        >
          <X size={16} />
        </Button>
        <DialogTitle>调用用量</DialogTitle>
        <DialogDescription>日志报告值</DialogDescription>
        {isLoading ? (
          <p>加载中...</p>
        ) : isError ? (
          <p role="alert">读取失败</p>
        ) : !data ? (
          <p>记录不存在</p>
        ) : (
          <dl className="detail-grid">
            <dt>来源</dt>
            <dd>{SOURCE_NAMES[data.appType as SourceId] ?? data.appType}</dd>
            <dt>模型</dt>
            <dd>{data.model}</dd>
            <dt>时间</dt>
            <dd>
              {new Date(data.createdAt * 1000).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </dd>
            <dt>新增输入</dt>
            <dd>
              {data.inputBreakdownComplete === false
                ? "未知"
                : fmtInt(data.inputTokens)}
            </dd>
            <dt>输出</dt>
            <dd>{fmtInt(data.outputTokens)}</dd>
            <dt>缓存命中</dt>
            <dd>{fmtInt(data.cacheReadTokens)}</dd>
            <dt>缓存写入</dt>
            <dd>
              {data.inputBreakdownComplete === false
                ? "未知"
                : fmtInt(data.cacheCreationTokens)}
            </dd>
            {data.inputBreakdownComplete === false && (
              <>
                <dt>未命中输入（未拆分写入）</dt>
                <dd>{fmtInt(data.inputTokens)}</dd>
              </>
            )}
            <dt>总 Token</dt>
            <dd>
              {fmtInt(
                data.inputTokens +
                  data.outputTokens +
                  data.cacheReadTokens +
                  data.cacheCreationTokens,
              )}
            </dd>
            <dt>参考费用 / 实际账单</dt>
            <dd>未知 / 未接入</dd>
            <dt>任务类型</dt>
            <dd>
              {data.executionKind === "background"
                ? "后台任务"
                : data.executionKind === "subagent"
                  ? "子代理任务"
                  : "未知"}
            </dd>
            <dt>实际发起人</dt>
            <dd>未归因</dd>
            <dt>记录指纹</dt>
            <dd className="fingerprint">{data.requestId}</dd>
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}
