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
const SignInPage = lazy(() => import("./routes/sign-in"));
const AdminPage = lazy(() => import("./routes/admin/index"));
const EmployeesPage = lazy(() => import("./routes/admin/employees"));
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

const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});

const employeesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/employees",
  component: EmployeesPage,
});

const essRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ess",
  component: EssPage,
});

const children: AnyRoute[] = [indexRoute, signInRoute, adminRoute, employeesRoute, essRoute];

if (
  import.meta.env.VITE_DEPLOYMENT_MODE === "multi_tenant_saas" ||
  import.meta.env.VITE_DEPLOYMENT_MODE === "holding_multi_tenant"
) {
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
