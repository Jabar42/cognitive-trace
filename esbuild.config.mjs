import esbuild from "esbuild";
import process from "process";

const isProd = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  platform: "browser",
  format: "cjs",
  target: "es2020",
  external: ["obsidian", "electron", "fs", "path"],
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  treeShaking: true,
  logLevel: "info",
});
