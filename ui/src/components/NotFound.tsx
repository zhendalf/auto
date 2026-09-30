import { Link } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle.ts";
import { BTN_PRIMARY } from "./ui.ts";

export function NotFound() {
  useDocumentTitle("Page not found");
  return (
    <div className="mx-auto max-w-xl py-12">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="mt-2 text-sm text-muted">There is nothing at this address.</p>
      <div className="mt-4">
        <Link to="/jobs" className={BTN_PRIMARY}>
          Back to jobs
        </Link>
      </div>
    </div>
  );
}
