// Builds content-api-mcp-<version>.mcpb for the Claude desktop app.
//
// Stages only what the bundle needs (manifest, compiled dist/, production
// node_modules) in build/mcpb, so dev tooling, src/ and .env never ship.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const stage = `${root}build/mcpb`;
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const manifest = JSON.parse(readFileSync(`${root}manifest.json`, "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json version ${manifest.version} != package.json version ${pkg.version}; align them first.`);
  process.exit(1);
}

run("npm", ["run", "build"]); // includes the read-only check

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["manifest.json", "package.json", "package-lock.json", "README.md", "dist"]) {
  cpSync(`${root}${file}`, `${stage}/${file}`, { recursive: true });
}
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

const out = `${root}content-api-mcp-${pkg.version}.mcpb`;
const mcpb = `${root}node_modules/.bin/mcpb`;
run(mcpb, ["validate", `${stage}/manifest.json`]);
run(mcpb, ["pack", stage, out]);
console.log(`\nBundle: ${out}`);
