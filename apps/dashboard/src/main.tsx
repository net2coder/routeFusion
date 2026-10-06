import React from "react";
import { createRoot } from "react-dom/client";
import App, { AppErrorBoundary } from "./App";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
