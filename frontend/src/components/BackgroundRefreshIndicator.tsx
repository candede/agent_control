import { useEffect, useState } from "react";
import { useIsFetching } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import "./automaticRefresh.css";

export function BackgroundRefreshIndicator({ active = false }: { active?: boolean }) {
  const savedReadsInFlight = useIsFetching({ queryKey: ["saved"] });
  return active || savedReadsInFlight > 0 ? <DelayedRefreshIndicator /> : null;
}

function DelayedRefreshIndicator() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 500);
    return () => window.clearTimeout(timer);
  }, []);

  return visible ? <div className="background-refresh-indicator" role="status" aria-label="Background refresh" aria-live="polite">
    <RefreshCw size={16} aria-hidden="true" />
  </div> : null;
}
