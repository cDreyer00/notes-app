/**
 * Copia o instalador recém-gerado para `project/release/`.
 *
 * O Tauri não tem opção de diretório de saída: o bundle sai enterrado em
 * `src-tauri/target/release/bundle/nsis/`, junto de milhares de artefatos de
 * compilação. Este passo traz só o que interessa para um lugar previsível.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleDir = join(projectDir, "src-tauri", "target", "release", "bundle", "nsis");
const outDir = join(projectDir, "release");

/** A versão vive só no Cargo.toml; ler de lá evita um segundo número a manter. */
function cargoVersion() {
  const raw = readFileSync(join(projectDir, "src-tauri", "Cargo.toml"), "utf8");
  return raw.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?";
}

let installers;
try {
  installers = readdirSync(bundleDir).filter((name) => name.endsWith(".exe"));
} catch {
  console.error(`Nenhum bundle em ${bundleDir}. Rode a build antes.`);
  process.exit(1);
}

if (installers.length === 0) {
  console.error(`Nenhum instalador em ${bundleDir}.`);
  process.exit(1);
}

// Mais recente primeiro: rebuilds sem bump de versão sobrescrevem o mesmo nome,
// mas uma troca de versão deixa os dois lá.
installers.sort(
  (a, b) => statSync(join(bundleDir, b)).mtimeMs - statSync(join(bundleDir, a)).mtimeMs,
);

const [installer] = installers;
const source = join(bundleDir, installer);
const target = join(outDir, installer);

mkdirSync(outDir, { recursive: true });
copyFileSync(source, target);

const mb = (statSync(target).size / 1024 / 1024).toFixed(2);
const version = cargoVersion();

console.log(`\nNotes ${version} — instalador pronto`);
console.log(`  ${target}`);
console.log(`  ${mb} MB\n`);

if (!installer.includes(version)) {
  console.warn(
    `Aviso: o instalador não traz a versão ${version} do Cargo.toml no nome.\n` +
      `Isso costuma ser bundle antigo — confira se a build rodou de fato.\n`,
  );
}
