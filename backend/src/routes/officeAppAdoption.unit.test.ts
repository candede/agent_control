import { describe, expect, it } from "vitest";
import { officeRequestQuery } from "./officeAppAdoption.js";
import { directorySourceRecord } from "../services/userSourceRecords.js";
describe("bounded Office route queries", () => {
  it("separates Office navigation from agent snapshots and preserves exact null/literal groups", () => {
    expect(officeRequestQuery({ company:"~null",department:"~string:~null",app:"word" }).query).toEqual({
      company:null,department:"~null",app:"word",
    });
  });
  it.each([{ snapshot:"agent" },{ app:"chat" },{ company:["x","y"] },{ limit:"101" },{ limit:"1e2" },{ pageNumber:"0" },
    { pageNumber:"9007199254740992" },{ cursor:"signed" },{ selectionId:"bad" },{ company:"x".repeat(257) }])(
    "rejects invalid route input %j", raw => { expect(()=>officeRequestQuery(raw,true)).toThrow(); });
  it("round-trips literal facets accepted by directory ingestion", () => {
    const saved = directorySourceRecord({
      serviceEvidenceVersion: 1, copilotServiceState: "disabled", servicePlans: [],
      identity: {
        objectId: "11111111-1111-4111-8111-111111111111", userPrincipalName: "reader@example.invalid",
        displayName: "Reader", accountEnabled: true, companyName: "Example\tCompany",
        department: "Research\u0001Development", userType: null, employeeType: null,
      },
    });
    expect(officeRequestQuery({ company: `~string:${saved.company}`, department: `~string:${saved.department}` }).query)
      .toEqual({ company: saved.company, department: saved.department });
  });
  it.each([
    { company: "~string:bad\0label" }, { department: "~string:bad\rlabel" }, { company: "~string:bad\nlabel" },
    { company: "~string:bad\uD800label" }, { search: "bad\tlabel" }, { cursor: "bad\tcursor" }, { anchor: "bad\tanchor" },
  ])("retains non-literal and source-text validation for %j", raw => {
    expect(() => officeRequestQuery(raw, true)).toThrow();
  });
});
