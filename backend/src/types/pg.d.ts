declare module "pg/lib/utils.js" {
  const utils: {
    prepareValue(value: unknown): string | Buffer | null | undefined;
  };
  export = utils;
}
