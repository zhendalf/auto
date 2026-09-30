import { useEffect } from "react";

const SUFFIX = "Auto";

/** Sets `document.title` to "<title> · Auto" for the life of the calling route. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SUFFIX}` : SUFFIX;
  }, [title]);
}
