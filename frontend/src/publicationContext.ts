import { createContext } from "react";
import type { PublicationRevisions } from "../../backend/src/types/dataSelection";

export const PublicationContext = createContext<{
  admit: (revisions: PublicationRevisions) => void;
  revisions?: PublicationRevisions;
} | undefined>(undefined);
