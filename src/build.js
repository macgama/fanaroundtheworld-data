// Script GitHub Actions : écrit les fichiers dans public/ pour GitHub Pages.
//   node src/build.js [--config config/competitions.json] [--out public]
// Le Worker Cloudflare produit les mêmes fichiers de son côté (src/files.js) ;
// GitHub Pages sert de copie de secours.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeFiles } from "./files.js";

export { ATTRIBUTION, dayRange, groupByDay } from "./files.js";

export async function build({ config, outDir, nowMs = Date.now(), env = process.env, log = console.log }) {
  const { index, files } = await makeFiles({ config, nowMs, env, log });
  for (const [path, content] of Object.entries(files)) {
    const target = join(outDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(content, null, path === "index.json" ? 2 : 0));
  }
  return index;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : def;
  };
  const config = JSON.parse(await readFile(arg("--config", "config/competitions.json"), "utf8"));
  await build({ config, outDir: arg("--out", "public") });
}
