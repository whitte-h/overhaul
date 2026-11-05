// Entry of the release executable (scripts/build.mjs bundles from here). Same as bin/overhaul.mjs.
import { main } from "./cli.mjs";

main(process.argv.slice(2)).catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(1);
});
