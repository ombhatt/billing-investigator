import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emitSql } from "./emitSql.js";
import { generateSyntheticData } from "./generateSyntheticData.js";

const OUTPUT = ".seed/golden.sql";

const dataset = generateSyntheticData();
const sql = emitSql(dataset);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, sql, "utf8");

process.stdout.write(
  `${OUTPUT} written: ` +
    [
      `${dataset.usageEvents.length} usage events`,
      `${dataset.dailyUsage.length} daily rows`,
      `${dataset.ratedCharges.length} rated charges`,
      `${dataset.invoices.length} invoices`,
      `${dataset.invoiceLines.length} invoice lines`,
      `${dataset.accountEvents.length} account events`
    ].join(", ") +
    "\n"
);
