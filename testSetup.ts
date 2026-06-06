import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach } from "bun:test";

GlobalRegistrator.register();

// Register cleanup after happy-dom is set up so that @testing-library/react
// is evaluated only after the global document/window exist.
const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
