import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createSavedQueryClient } from "../savedQueries";

export function SavedQueryProvider({ children, client: suppliedClient }: { children: ReactNode; client?: QueryClient }) {
  const [client] = useState(() => suppliedClient ?? createSavedQueryClient());
  useEffect(() => () => { if (!suppliedClient) client.clear(); }, [client, suppliedClient]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
