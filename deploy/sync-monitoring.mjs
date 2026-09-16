#!/usr/bin/env node
// Synchronize only Autodom artifacts into an existing Domcom monitoring checkout.
// This writes files, never starts containers or changes the running stack.
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSeq, parseDocument } from "yaml";

const source = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error("Usage: node deploy/sync-monitoring.mjs /path/to/domcom-checkout");
  process.exitCode = 1;
} else {
  const root = resolve(target);
  const configPath = join(root, "monitoring/prometheus/visual-prometheus.yml");
  const alloyPath = join(root, "monitoring/alloy/config.alloy");
  const [configText, additionsText, alloyText, fragment] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(join(source, "monitoring-scrape.yml"), "utf8"),
    readFile(alloyPath, "utf8"),
    readFile(join(source, "alloy/autodom.alloy"), "utf8"),
  ]);
  const config = parseDocument(configText);
  const additions = parseDocument(additionsText);
  if (config.errors.length || additions.errors.length) throw new Error("Invalid Prometheus YAML");
  const jobs = config.get("scrape_configs", true);
  const incoming = additions.get("scrape_configs", true);
  const rules = config.get("rule_files", true);
  if (!isSeq(jobs) || !isSeq(incoming) || !isSeq(rules))
    throw new Error("Expected existing Domcom scrape_configs and rule_files sequences");
  const allowed = new Set(["autodom-bot", "autodom-full-bot", "autodom-worker", "autodom-vin"]);
  const seen = new Set();
  for (const job of incoming.items) {
    const name = job.get("job_name");
    if (!allowed.has(name) || seen.has(name)) throw new Error("Unexpected or duplicate Autodom job");
    seen.add(name);
    const matches = jobs.items.flatMap((item, index) => item.get("job_name") === name ? [index] : []);
    if (matches.length > 1) throw new Error(`Duplicate existing job: ${name}`);
    if (matches.length) jobs.items[matches[0]] = job.clone();
    else jobs.add(job.clone());
  }
  if (seen.size !== allowed.size) throw new Error("All four Autodom jobs are required");
  if (!rules.items.some((item) => item.value === "/etc/prometheus/autodom.rules.yml"))
    rules.add("/etc/prometheus/autodom.rules.yml");
  const begin = "// BEGIN AUTODOM MANAGED PIPELINE\n";
  const end = "// END AUTODOM MANAGED PIPELINE";
  const start = alloyText.indexOf(begin);
  const finish = alloyText.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start))
    throw new Error("Invalid existing Autodom Alloy markers");
  if (start < 0 && /loki\.process\s+"autodom"/u.test(alloyText))
    throw new Error("Unmanaged Autodom Alloy pipeline already exists; reconcile it first");
  const managed = `${begin}${fragment.trimEnd()}\n${end}`;
  const nextAlloy = start < 0
    ? `${alloyText.trimEnd()}\n\n${managed}\n`
    : `${alloyText.slice(0, start)}${managed}${alloyText.slice(finish + end.length)}`;
  await writeFile(configPath, config.toString());
  await writeFile(alloyPath, nextAlloy);
  await copyFile(join(source, "prometheus/autodom.rules.yml"), join(root, "monitoring/prometheus/autodom.rules.yml"));
  const dashboardDir = join(root, "monitoring/grafana/dashboards/autodom");
  await mkdir(dashboardDir, { recursive: true });
  for (const name of await readdir(join(source, "grafana/dashboards"))) {
    if (name.endsWith(".json")) await copyFile(join(source, "grafana/dashboards", name), join(dashboardDir, name));
  }
  console.log("Synchronized Autodom jobs, rules, Alloy pipeline and dashboards. No services restarted.");
}
