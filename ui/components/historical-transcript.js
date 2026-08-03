import { createElement as h, memo, useEffect, useRef } from "react";
import { Static } from "ink";
import { emitPerformanceTimings } from "../../app/performance-timings.js";
import { Banner } from "./banner.js";
import { MessageList } from "./message-list.js";

export const HistoricalTranscript = memo(function HistoricalTranscript({
  items,
  sessionKey,
  model,
  workspace,
  agent,
  autoApprove,
}) {
  const renderStartedAt = useRef(performance.now());
  useEffect(() => {
    emitPerformanceTimings("ink-resume", {
      firstInkRenderMs: performance.now() - renderStartedAt.current,
      historicalRowRenderCount: Math.max(0, items.length - 1),
    });
  }, []);
  return h(Static, {
    key: `history-${sessionKey}`,
    items,
  }, item => item.type === "banner"
    ? h(Banner, {
        key: item.id,
        model,
        workspace,
        agent,
        autoApprove,
      })
    : h(MessageList, { key: item.id, messages: [item] }));
}, (previous, next) => previous.sessionKey === next.sessionKey
  && previous.items.length === next.items.length
  && previous.items.at(-1) === next.items.at(-1)
  && previous.model === next.model
  && previous.agent === next.agent
  && previous.autoApprove === next.autoApprove);
