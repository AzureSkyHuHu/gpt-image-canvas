import React from "react";
import { createRoot } from "react-dom/client";
import "tldraw/tldraw.css";
import "./styles.css";
import { App } from "./App";
import { AuthGate } from "./AuthGate";
import { LanguageProvider } from "./i18n";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <LanguageProvider>
      <AuthGate>
        <App />
      </AuthGate>
    </LanguageProvider>
  </React.StrictMode>
);
