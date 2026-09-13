#!/usr/bin/env node
// Import only Autodom dashboards; preserve existing datasources and other folders.
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const base = process.env.GRAFANA_URL;
const token = process.env.GRAFANA_TOKEN;
const user = process.env.GRAFANA_USER;
const password = process.env.GRAFANA_PASSWORD;
if (!base || (!token && (!user || !password)))
  throw new Error("Set GRAFANA_URL and GRAFANA_TOKEN, or GRAFANA_USER/GRAFANA_PASSWORD via environment");
const url = new URL(base);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
  throw new Error("GRAFANA_URL must be an HTTP(S) base URL without credentials/query/fragment");
const authorization = token ? `Bearer ${token}` : `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
async function api(path, method = "GET", body) {
  const response = await fetch(`${base.replace(/\/$/u, "")}${path}`, {
    method,
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Grafana ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}
const datasources = await api("/api/datasources");
for (const type of ["prometheus", "loki"])
  if (!datasources.some((item) => item.type === type && item.uid === type))
    throw new Error(`Existing datasource UID ${type} is required; no datasource is modified by this script`);
const folders = await api("/api/folders?limit=1000");
let folder = folders.find((item) => item.uid === "autodom");
if (!folder) folder = await api("/api/folders", "POST", { uid: "autodom", title: "Autodom" });
const directory = new URL("./grafana/dashboards/", import.meta.url);
for (const name of await readdir(directory)) {
  if (!name.endsWith(".json")) continue;
  const dashboard = JSON.parse(await readFile(new URL(name, directory), "utf8"));
  if (dashboard.uid !== "autodom-overview") throw new Error(`Unexpected dashboard UID in ${name}`);
  const result = await api("/api/dashboards/db", "POST", {
    dashboard, folderUid: folder.uid, overwrite: true, message: "Autodom repository provisioning",
  });
  if (result.status !== "success") throw new Error(`Grafana rejected ${fileURLToPath(new URL(name, directory))}`);
  console.log(`${base.replace(/\/$/u, "")}${result.url}`);
}
