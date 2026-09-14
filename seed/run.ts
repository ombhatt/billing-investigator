import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ACCOUNT_PROFILES } from "./constants.js";
import { emitSql } from "./emitSql.js";
import { generateSyntheticData } from "./generateSyntheticData.js";

const OUTPUT = ".seed/golden.sql";

const datasets = ACCOUNT_PROFILES.map((profile) =>
  generateSyntheticData(profile)
);
const sql = emitSql(...datasets);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, sql, "utf8");

const total = (pick: (d: (typeof datasets)[number]) => number) =>
  datasets.reduce((sum, d) => sum + pick(d), 0);

process.stdout.write(
  `${OUTPUT} written: ` +
    [
      `${datasets.length} account${datasets.length === 1 ? "" : "s"}`,
      `${total((d) => d.usageEvents.length)} usage events`,
      `${total((d) => d.dailyUsage.length)} daily rows`,
      `${total((d) => d.ratedCharges.length)} rated charges`,
      `${total((d) => d.invoices.length)} invoices`,
      `${total((d) => d.invoiceLines.length)} invoice lines`,
      `${total((d) => d.accountEvents.length)} account events`
    ].join(", ") +
    "\n"
);
