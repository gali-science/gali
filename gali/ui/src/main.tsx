import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WorkspaceHealthProvider } from "./app/workspace-health";
import { GaliAuthProvider } from "./auth";
import { TryPage } from "./features/try/TryPage";
import { PlatformProvider } from "./platform/context";
import { bootPlatform } from "./platform/runtime";
import "./styles.css";

const platform = bootPlatform();
// ?try opens the no-login page on its own, without auth or a sandbox.
const tryOnly = new URLSearchParams(window.location.search).has("try");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {tryOnly ? (
      <TryPage
        signIn={(label, className) => <a className={className} href="./">{label}</a>}
        joinWaitlist={(label, className) => <a className={className} href="./?waitlist">{label}</a>}
      />
    ) : (
      <PlatformProvider platform={platform}>
        <WorkspaceHealthProvider>
          <GaliAuthProvider>
            <App />
          </GaliAuthProvider>
        </WorkspaceHealthProvider>
      </PlatformProvider>
    )}
  </StrictMode>,
);
