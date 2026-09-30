import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Shell } from "./components/Shell.tsx";
import { NotFound } from "./components/NotFound.tsx";
import { ToastProvider } from "./components/Toast.tsx";
import { JobsRoute } from "./routes/JobsRoute.tsx";
import { JobDetailRoute } from "./routes/JobDetailRoute.tsx";
import { RunsRoute } from "./routes/RunsRoute.tsx";
import { RunDetailRoute } from "./routes/RunDetailRoute.tsx";
import { useSSE } from "./api/sseHook.ts";

/**
 * Mounted once inside the QueryClientProvider so the SSE subscription has a
 * QueryClient context. Renders nothing.
 */
function SSEMount() {
  useSSE();
  return null;
}

export function App() {
  return (
    <>
      <SSEMount />
      <BrowserRouter>
        <ToastProvider>
          <Routes>
            <Route element={<Shell />}>
              <Route index element={<Navigate to="/jobs" replace />} />
              <Route path="/jobs" element={<JobsRoute />} />
              <Route path="/jobs/:name" element={<JobDetailRoute />} />
              <Route path="/runs" element={<RunsRoute />} />
              <Route path="/runs/:run_id" element={<RunDetailRoute />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </BrowserRouter>
    </>
  );
}
