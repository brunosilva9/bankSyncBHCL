// Uso: npm run detect -- <archivos o carpetas>
// Muestra qué reconoce la app en cada archivo (banco, producto, variante, cuenta) sin importar nada.
import fs from 'node:fs';
import path from 'node:path';
import { describeDetection, detectStatement } from '../parser/detect.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Uso: npm run detect -- <archivos o carpetas>');
  process.exit(1);
}

const files = args.flatMap((a) =>
  fs.statSync(a).isDirectory()
    ? fs
        .readdirSync(a)
        .filter((f) => /\.(txt|xlsx?)$/i.test(f))
        .map((f) => path.join(a, f))
    : [a],
);

let known = 0;
for (const f of files) {
  const d = await detectStatement(fs.readFileSync(f));
  if (d) known++;
  const what = d ? `${describeDetection(d)}${d.supported ? '' : '  [aún no se importa]'}` : '— no reconocido';
  console.log(`${path.basename(f)}\n   ${what}`);
}
console.log(`\n${known} de ${files.length} archivos reconocidos.`);
