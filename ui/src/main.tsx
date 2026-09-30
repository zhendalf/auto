import "./styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.tsx";
import { loadBootstrap } from "./bootstrap.ts";
import { NotServed } from "./components/NotServed.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { shouldRetry } from "./util/errors.ts";

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // A 4xx is an answer (token changed, not found); retrying it only delays
      // the message. Brief outages are retried twice.
      retry: shouldRetry,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 4_000),
    },
  },
});

const rootEl = document.getElementById("app");
if (!rootEl) throw new Error("#app element not found");

const root = createRoot(rootEl);
if (!loadBootstrap()) {
  // No supervisor page around us: say so instead of rendering a blank screen.
  root.render(
    <React.StrictMode>
      <NotServed />
    </React.StrictMode>,
  );
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={qc}>
          <App />
        </QueryClientProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
