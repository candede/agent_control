globalThis.Bridge = require("@kusto/language-service-next/bridge.js");
require("@kusto/language-service-next/Kusto.Language.Bridge.js");

const { Kusto } = globalThis;

function values(collection) {
  return Array.from({ length: collection.Count }, (_, index) => collection.getItem(index));
}

function compileKusto(query, tables = []) {
  const symbols = Kusto.Language.Symbols;
  const tableSymbols = tables.map(table => new symbols.TableSymbol.$ctor7(table.name, table.schema, ""));
  const database = new symbols.DatabaseSymbol.ctor("agent_control_semantic_tests", tableSymbols);
  const globals = Kusto.Language.GlobalState.Default.WithDatabase(database);
  const code = Kusto.Language.KustoCode.ParseAndAnalyze(query, globals);

  return {
    diagnostics: values(code.GetDiagnostics()).map(diagnostic => ({
      code: diagnostic.Code,
      severity: diagnostic.Severity,
      message: diagnostic.Message,
      start: diagnostic.Start,
      length: diagnostic.Length,
    })),
    columns: values(code.ResultType.Columns).map(column => ({
      name: column.Name,
      type: column.Type.Name,
    })),
  };
}

module.exports = { compileKusto };