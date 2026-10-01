import { useEffect } from "react";

/**
 * Stripe may deliver its payment webhook after the buyer returns to the app.
 * Refresh for a bounded period; the redirect itself is never proof of payment.
 */
export function useCheckoutCreditRefresh(refresh: () => Promise<void>) {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("checkout") !== "success") return;
    let attempts = 0;
    let inFlight = false;
    const timer = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refresh();
      } catch {
        console.warn("Could not refresh credits after checkout. Reload to check your balance.");
      } finally {
        inFlight = false;
        if (++attempts >= 30) window.clearInterval(timer);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);
}