import "./zodConfig";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { pickEngineClient } from "./engine/select";
import "./fonts.css";
import "./theme.css";
import "./ui.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from studio/renderer/index.html");

createRoot(root).render(
  <StrictMode>
    <App client={pickEngineClient()} />
  </StrictMode>
);
