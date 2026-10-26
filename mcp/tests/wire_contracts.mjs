// Read TypeScript types, not application configuration or runtime modules.
import ts from "../../node_modules/typescript/lib/typescript.js";
import path from "node:path";
const file = path.resolve("tests/wire_contracts.ts");
const program = ts.createProgram([file], {
  strict: true, skipLibCheck: true, target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(file);
const declaration = source.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === "Contracts");
const type = checker.getTypeAtLocation(declaration);
function sample(type, name, depth = 0, complete = false) {
  if (depth > 25) throw Error(`Recursive wire contract ${name}`);
  if (type.flags & ts.TypeFlags.Any || type.flags & ts.TypeFlags.Unknown) {
    // Deliberately dynamic source maps are not domain rows.
    if (name === "metadata" || name === "sources") return {};
    throw Error(`Unspecified source type for ${name}: ${checker.typeToString(type)}`);
  }
  if (type.isUnion()) {
    const candidates = type.types.filter(item => !(item.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)));
    return sample(candidates[0] ?? type.types[0], name, depth + 1, complete);
  }
  if (type.flags & ts.TypeFlags.StringLiteral) return type.value;
  if (type.flags & ts.TypeFlags.NumberLiteral) return type.value;
  if (type.flags & ts.TypeFlags.BooleanLiteral) return type.intrinsicName === "true";
  if (type.flags & ts.TypeFlags.TemplateLiteral) return "/sync";
  if (type.flags & ts.TypeFlags.Null) return null;
  if (type.flags & ts.TypeFlags.String) {
    if (/revision|hash/i.test(name)) return "a".repeat(64);
    if (/date|at$|time$|reportingStart|reportingEnd/i.test(name)) return "2026-10-16T00:00:00Z";
    if (name === "href") return "/sync";
    return "12345678-1234-4234-8234-123456789abc";
  }
  if (type.flags & ts.TypeFlags.Number) return name === "httpStatus" ? 200 : 1;
  if (type.flags & ts.TypeFlags.Boolean) return true;
  if (checker.isArrayType(type)) {
    const element = checker.getTypeArguments(type)[0];
    // Current inventory freshness intentionally uses unknown[], unlike domain evidence.
    if (element.flags & ts.TypeFlags.Unknown) return [];
    return [sample(element, name, depth + 1, complete)];
  }
  const properties = checker.getPropertiesOfType(type);
  const result = {};
  for (const property of properties) {
    if (!complete && property.flags & ts.SymbolFlags.Optional) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    // Inferred discriminated return types use optional never for impossible union fields.
    if (propertyType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Never)) continue;
    result[property.name] = sample(propertyType, property.name, depth + 1, complete);
  }
  const indexed = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (complete && indexed && !(indexed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
    result.evidence = sample(indexed, name, depth + 1, complete);
  }
  return result;
}
const fixtures = {};
const complete = {};
for (const property of checker.getPropertiesOfType(type)) {
  fixtures[property.name] = sample(checker.getTypeOfSymbolAtLocation(property, declaration), property.name);
  complete[property.name] = sample(checker.getTypeOfSymbolAtLocation(property, declaration), property.name, 0, true);
}
fixtures.complete = complete;
console.log(JSON.stringify(fixtures));
