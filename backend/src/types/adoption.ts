import type { ReportListPage } from "./officialReportData.js";
import type { UserSourceMetadata } from "./userSources.js";

export type AdoptionPerson = {
  id: string;
  name: string;
  agents: number;
  responses: number | null;
  champion: boolean;
};

export type AdoptionAgent = {
  id: string;
  name: string;
  description: string | null;
  type: string | null;
};

export type AdoptionGroup = {
  id: string;
  company: string;
  department: string;
  people: AdoptionPerson[];
  agents: AdoptionAgent[];
};

export type AdoptionPage = ReportListPage<AdoptionGroup> & {
  directory: UserSourceMetadata;
  inventoryAvailable: boolean;
  summary: { people: number; champs: number; agents: number };
};
