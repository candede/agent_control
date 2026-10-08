import { useEffect, useState, type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createSavedQueryClient } from "../savedQueries";

type Props = { children: ReactNode; client?: QueryClient };

export function SavedQueryProvider({ children, client }: Props) {
  const [scope, setScope] = useState({ client, generation: 0 });
  if (scope.client !== client) setScope({ client, generation: scope.generation + 1 });
  // Query hooks retain their first observer/client; changing context alone cannot transfer ownership.
  return <SavedQueryScope key={scope.generation} client={client}>{children}</SavedQueryScope>;
}

function SavedQueryScope({ children, client: suppliedClient }: Props) {
  const [client] = useState(() => suppliedClient ?? createSavedQueryClient());
  useEffect(() => () => { if (!suppliedClient) client.clear(); }, [client, suppliedClient]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
