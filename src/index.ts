import { hideBin } from "yargs/helpers";
import { runCli } from "./cli.ts";

const exitCode = await runCli(hideBin(process.argv));

if (exitCode !== 0) {
  process.exit(exitCode);
}
