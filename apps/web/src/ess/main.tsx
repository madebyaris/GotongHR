import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { hydrateEss } from "./cache";
import { ClockScreen } from "./clock";
import "./ess.css";
import { holdOutbox } from "./owner";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root.");

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

void start(root, client);

async function start(element: HTMLElement, queryClient: QueryClient): Promise<void> {
  holdOutbox();
  await hydrateEss(queryClient);
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    await navigator.serviceWorker.register("/ess-sw.js").catch(() => undefined);
  }
  createRoot(element).render(
    <QueryClientProvider client={queryClient}>
      <ClockScreen />
    </QueryClientProvider>,
  );
}
