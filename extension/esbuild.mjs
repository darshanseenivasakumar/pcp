// Bundles the extension and the dev mock server into out/.
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info",
};

const builds = [
  { ...common, entryPoints: ["src/extension.ts"], outfile: "out/extension.js", external: ["vscode"] },
  { ...common, entryPoints: ["dev/mock-main.ts"], outfile: "out/mock-server.js" },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
