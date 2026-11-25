import { QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  type AnyRoute,
} from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { queryClient } from "./lib/query";

const HomePage = lazy(() => import("./routes/home"));
const AdminPage = lazy(() => import("./routes/admin/index"));
const EssPage = lazy(() => import("./routes/ess/index"));

function Root() {
  return (
    <QueryClientProvider client={queryClient}>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </QueryClientProvider>
  );
}

const rootRoute = createRootRoute({ component: Root });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});

const essRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ess",
  component: EssPage,
});

const children: AnyRoute[] = [indexRoute, adminRoute, essRoute];

if (import.meta.env.VITE_DEPLOYMENT_MODE !== "single_tenant") {
  const PlatformPage = lazy(() => import("./routes/platform/index"));
  children.push(
    createRoute({
      getParentRoute: () => rootRoute,
      path: "/platform",
      component: PlatformPage,
    }),
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren(children),
});
