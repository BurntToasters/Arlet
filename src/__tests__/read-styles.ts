import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** base.css is an ordered @import index; inline it like the bundler does. */
export function readShellStyles(): string {
  const index = resolve(process.cwd(), "src/styles/base.css");
  return readFileSync(index, "utf8").replace(
    /@import\s+"([^"]+)";/gu,
    (_match, file: string) =>
      readFileSync(resolve(dirname(index), file), "utf8"),
  );
}
