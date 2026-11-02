import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const startup = source.statements.find(statement => ts.isLabeledStatement(statement) && statement.label.text === "startupRecovery");
if (!startup || !ts.isLabeledStatement(startup) || !ts.isIfStatement(startup.statement)
  || !ts.isBlock(startup.statement.thenStatement)) throw new Error("Startup recovery block is missing.");
const recoveryBlock = startup.statement.thenStatement;

describe("bounded startup recovery wiring", () => {
  it.each(["packageInventory", "purviewAudit"])("drains every %s batch behind live admissions before HTTP startup", service => {
    const loop = recoveryBlock.statements.find(statement => ts.isWhileStatement(statement)
      && statement.expression.getText(source).includes(`${service}.recover()`));
    expect(loop).toBeDefined();
    if (!loop || !ts.isWhileStatement(loop)) throw new Error(`${service} recovery loop is missing.`);
    expect(loop.expression.getText(source)).toBe(`await recoveryAdmissionsOpen() && await ${service}.recover() > 0`);
    expect(loop.statement.getText(source)).toContain("await new Promise<void>(resolve => setImmediate(resolve))");
    const next = recoveryBlock.statements[recoveryBlock.statements.indexOf(loop) + 1];
    expect(next.getText(source)).toBe("if (!await recoveryAdmissionsOpen()) break startupRecovery;");
    const appCreation = source.statements.find(statement => ts.isVariableStatement(statement)
      && statement.getText(source).includes("createApp()"));
    expect(appCreation).toBeDefined();
    expect(loop.end).toBeLessThan(appCreation!.pos);
  });
});
