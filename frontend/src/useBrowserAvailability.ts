import { useEffect, useState } from "react";

export function useBrowserAvailability() {
  const read = () => document.visibilityState === "visible" && navigator.onLine;
  const [available, setAvailable] = useState(read);
  useEffect(() => {
    const changed = () => setAvailable(read());
    document.addEventListener("visibilitychange", changed);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      document.removeEventListener("visibilitychange", changed);
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
    };
  }, []);
  return available;
}
