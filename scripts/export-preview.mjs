import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [snapshotInput, outputInput] = process.argv.slice(2);
if (!snapshotInput || !outputInput)
  throw new Error("Usage: node scripts/export-preview.mjs SNAPSHOT.json OUTPUT_DIRECTORY");
const output = resolve(outputInput);
const marker = ".atom-swarm-preview.json";
const owner = "atom-swarm-lab-static-preview-v1";
if (existsSync(output)) {
  if (lstatSync(output).isSymbolicLink() || !lstatSync(output).isDirectory())
    throw new Error("Output must be a real directory");
  if (
    output !== join(root, "output", "preview") ||
    !existsSync(join(output, marker)) ||
    JSON.parse(readFileSync(join(output, marker), "utf8")).owner !== owner
  ) {
    throw new Error("Refusing to overwrite an existing directory without this exporter's ownership marker");
  }
}
const source = JSON.parse(readFileSync(resolve(snapshotInput), "utf8"));
if (!source.coordination || !source.budget || !Array.isArray(source.coordination.agents)) {
  throw new Error("Expected a LabSnapshot with coordination and budget data");
}

function sanitize(value) {
  if (typeof value === "string") {
    if (
      /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(value)
    ) {
      throw new Error("Potential credential in snapshot; review the source before exporting");
    }
    return value.replace(/(^|[\s"'(=])(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)[^\s"'<>),;]*/g, "$1[local path]");
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/(?:secret|password|authorization|credential|private.?key|api.?key|token$)/i.test(key))
        .map(([key, child]) => [key, sanitize(child)]),
    );
  }
  return value;
}

const snapshot = sanitize({ coordination: source.coordination, budget: source.budget });
snapshot.preview = {
  recordedAt: new Date(source.coordination.now).toISOString(),
  description:
    "Three coding agents independently claimed math, renderer and interface tasks, exchanged messages, and produced the interactive ray tracer. External model token usage and cost were not available.",
};
const ui = join(root, "ui_dist");
if (!existsSync(join(ui, "index.html"))) throw new Error("Build the dashboard first with npm run build:ui");
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output, { recursive: true });
if (realpathSync(output) !== output) throw new Error("Output path must not traverse symbolic links");
cpSync(ui, output, { recursive: true, dereference: false });
const dashboardHtml = join(output, "index.html");
writeFileSync(
  dashboardHtml,
  readFileSync(dashboardHtml, "utf8").replace("<title>Pi Swarm</title>", "<title>Atom Swarm Lab</title>"),
);
cpSync(join(root, "examples", "raytracer"), join(output, "raytracer"), { recursive: true, dereference: false });
const rayHtml = join(output, "raytracer", "index.html");
// Directory normalization on static hosts must not change relative module/style URLs.
writeFileSync(rayHtml, readFileSync(rayHtml, "utf8").replace("<head>", '<head>\n    <base href="/raytracer/" />'));
writeFileSync(join(output, "recorded-run.json"), JSON.stringify(snapshot, null, 2));
writeFileSync(join(output, marker), JSON.stringify({ owner }, null, 2));
writeFileSync(
  join(output, "vercel.json"),
  JSON.stringify(
    {
      redirects: [{ source: "/", destination: "/lab", permanent: false }],
      rewrites: [
        { source: "/api/lab/status", destination: "/recorded-run.json" },
        { source: "/raytracer", destination: "/raytracer/index.html" },
        { source: "/lab", destination: "/index.html" },
      ],
      headers: [{ source: "/recorded-run.json", headers: [{ key: "Cache-Control", value: "public, max-age=300" }] }],
    },
    null,
    2,
  ),
);
console.log(`Static preview exported to ${output}`);
console.log("Recorded dashboard: /lab · interactive ray tracer: /raytracer/");
