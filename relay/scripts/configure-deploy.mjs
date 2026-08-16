import { readFile, writeFile } from "node:fs/promises";
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID ?? "";

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("CLOUDFLARE_D1_DATABASE_ID must be a D1 database UUID");
}

const source = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
source.d1_databases[0].database_id = databaseId;
await writeFile(
  new URL("../wrangler.deploy.json", import.meta.url),
  `${JSON.stringify(source, null, 2)}\n`,
);
