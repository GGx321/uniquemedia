import "./zodConfig";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { pickEngineClient } from "./engine/select";
import { installFileDropGuard } from "./screens/montage/mine";
import "./fonts.css";
import "./theme.css";
import "./ui.css";
import "./montage.css";
import "./videos.css";
import "./categories.css";
import "./scenes.css";
import "./autopilot.css";
import "./look.css";
import "./portraits.css";
import "./body.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from studio/renderer/index.html");

// 3f.6 round 2 (M13): files dropped anywhere but the «Мои» drop zone do nothing, and the window never opens them (main also refuses to
// navigate to a file:// URL).
installFileDropGuard(window);

createRoot(root).render(
  <StrictMode>
    <App client={pickEngineClient()} />
  </StrictMode>
);
