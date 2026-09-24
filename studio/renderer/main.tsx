import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/geologica";
import "@fontsource-variable/onest";
import "@fontsource-variable/martian-mono";
import "./theme.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from studio/renderer/index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
