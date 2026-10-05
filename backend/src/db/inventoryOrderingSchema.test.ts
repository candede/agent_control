import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { verifySchema } from "./schema.js";

describe("canonical inventory ICU ordering schema", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); });
  afterAll(async () => { await fixture?.close(); });
  it("verifies the actual ICU catalog and retains base-sensitive and numeric-version comparisons", async () => {
    const locales = (await fixture.operator.query(`SELECT collname,
      coalesce(to_jsonb(c)->>'colliculocale',to_jsonb(c)->>'colllocale') AS locale
      FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
      WHERE n.nspname='public' AND collname IN ('inventory_text_order','inventory_version_order') ORDER BY collname`)).rows;
    expect(locales.map(row => ({ name: row.collname, locale: new Intl.Locale(row.locale).toString() }))).toEqual([
      { name: "inventory_text_order", locale: "en-US-u-ks-level1" },
      { name: "inventory_version_order", locale: "en-US-u-kn-ks-level1" },
    ]);
    await expect(verifySchema(fixture.operator)).resolves.toBeUndefined();
    expect((await fixture.runtime.query(`SELECT 'é' COLLATE inventory_text_order='e' AS accents,
      'A' COLLATE inventory_text_order='a' AS casing,'2' COLLATE inventory_version_order<'10' AS versions`)).rows[0])
      .toEqual({ accents: true, casing: true, versions: true });
  });
  it("rejects a genuinely different collation rather than accepting an accent-sensitive substitute", async () => {
    await fixture.operator.query(`ALTER COLLATION inventory_text_order RENAME TO inventory_text_order_expected;
      CREATE COLLATION inventory_text_order(provider=icu,locale='en-US-u-ks-level2',deterministic=false)`);
    try { await expect(verifySchema(fixture.operator)).rejects.toThrow("inventory_ordering_schema"); }
    finally {
      await fixture.operator.query(`DROP COLLATION inventory_text_order;
        ALTER COLLATION inventory_text_order_expected RENAME TO inventory_text_order`);
    }
    await expect(verifySchema(fixture.operator)).resolves.toBeUndefined();
  });
});
