// Both adoption and restricted discovery rank the same resolved report people.
export function championOrderSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `${p}responses DESC NULLS LAST,${p}agents DESC,lower(${p}name) COLLATE "C",${p}identity`;
}
