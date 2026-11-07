import fs from "node:fs";
import { loadConfig } from "../src/config.js";
import { mintToken } from "../src/token.js";

/**
 * Mints the credential healthd will send. The value is deliberately NOT
 * printed: read it yourself when you are ready to type it into the phone.
 */
const config = loadConfig();

if (fs.existsSync(config.tokenFile) && !process.argv.includes("--force")) {
  process.stderr.write(
    `vitals: a credential already exists at ${config.tokenFile}\n` +
      `  re-mint with --force (the phone must then be updated too)\n`,
  );
  process.exit(1);
}

const { file } = mintToken(config.tokenFile);
process.stdout.write(
  `vitals: minted a 32-byte credential, mode 0600\n` +
    `  file:   ${file}\n` +
    `  header: ${config.tokenHeader}\n` +
    `  value:  not printed. Read it with:  cat "${file}"\n`,
);
