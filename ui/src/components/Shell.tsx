import { useEffect, useRef } from "react";
import { Outlet, NavLink, Link, useLocation } from "react-router-dom";
import { ConfigStatusBanner } from "./ConfigStatusBanner.tsx";
import { ConnectionBar } from "./ConnectionBar.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { StatusPanel } from "./StatusPanel.tsx";
import { timeZoneAbbreviation } from "../util/format.ts";

const NAV = [
  { to: "/jobs", label: "Jobs" },
  { to: "/runs", label: "Runs" },
];

export function Shell() {
  // Keyed by path so a render error on one page does not follow you to the next.
  const { pathname } = useLocation();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // A client-side navigation replaces the page without a load, so focus would
  // stay on a link that no longer exists. Move it to the content, like a real
  // page load would. Not on the first render (that is the load itself).
  const mainRef = useRef<HTMLElement | null>(null);
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (firstPath.current === pathname) return;
    firstPath.current = pathname;
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
      >
        Skip to content
      </a>
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-4 py-2.5">
        <Link to="/jobs" className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <img src="/favicon.svg" alt="" width={20} height={20} className="h-5 w-5" />
          Auto
        </Link>
        <nav aria-label="Main" className="flex gap-1 text-sm">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 font-medium ${
                  isActive ? "bg-sunken text-fg" : "text-muted hover:bg-sunken hover:text-fg"
                }`
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <StatusPanel />
        </div>
      </header>
      <ConnectionBar />
      <ConfigStatusBanner />
      <main ref={mainRef} id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-4 py-5 focus:outline-none">
        <ErrorBoundary key={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className="border-t border-line px-4 py-2 text-xs text-subtle">
        Times are shown in your local time zone: {timeZoneAbbreviation()} ({zone}).
      </footer>
    </div>
  );
}
