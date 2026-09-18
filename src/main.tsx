import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

const currentLabel = (window as Window & {
  __TAURI_INTERNALS__?: { metadata?: { currentWindow?: { label?: string } } };
}).__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
if (["overlay", "result", "radial", "selectionbar"].includes(currentLabel || "")) {
  document.documentElement.classList.add("overlay-window");
  document.body.classList.add("overlay-window");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
