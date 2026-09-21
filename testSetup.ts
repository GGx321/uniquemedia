import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach } from "bun:test";
import { exiftool } from "exiftool-vendored";

GlobalRegistrator.register();

// Register cleanup after happy-dom is set up so that @testing-library/react
// is evaluated only after the global document/window exist.
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);

// `bun test` exits without running exiftool-vendored's own shutdown hooks, so
// every run that touched exiftool left one `exiftool -stay_open` orphan behind
// (59 were found on one machine). The client is a process-wide singleton and
// ending it is irreversible — a per-file `end()` broke the next file with
// "BatchCluster has ended" — so it is ended exactly once, here, after the last
// file of the run. A run that never spawned it ends nothing.
afterAll(() => exiftool.end());
