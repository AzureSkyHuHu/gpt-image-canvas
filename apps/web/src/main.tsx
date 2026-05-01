import React from "react";
import { createRoot } from "react-dom/client";
import "tldraw/tldraw.css";
import "./styles.css";
import { App } from "./App";
import { AuthGate } from "./AuthGate";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>
);
