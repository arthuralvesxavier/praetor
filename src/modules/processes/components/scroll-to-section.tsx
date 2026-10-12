"use client";

import { useEffect } from "react";

/**
 * Brings a section of the page into view after render. Used when an old process link
 * (`?aba=audiencias`, `?aba=emails`…) opens the merged tab that now holds that content.
 * Does nothing when the URL already has a hash (the browser handles it) or the element
 * does not exist (e.g. a section hidden by permission).
 */
export function ScrollToSection({ id }: { id: string }) {
  useEffect(() => {
    if (window.location.hash) return;
    // After the navigation scroll handling of the router.
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [id]);
  return null;
}
