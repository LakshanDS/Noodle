/**
 * Hash-based routing (createWebHashHistory). We serve a single self-contained
 * index.html at GET / with no SPA catch-all, so hash routing means refresh on
 * any deep link (e.g. /#/runs/job-19) resolves against that one route without
 * the server needing to know about client paths.
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/runs" },
  { path: "/login", name: "login", component: () => import("./views/LoginView.vue") },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/runs/:id", name: "run-detail", component: () => import("./views/RunDetailView.vue"), props: true },
  { path: "/crons", name: "crons", component: () => import("./views/CronsView.vue") },
  { path: "/crons/new", name: "cron-new", component: () => import("./views/CronDetailView.vue"), props: { isNew: true } },
  { path: "/crons/:id", name: "cron-detail", component: () => import("./views/CronDetailView.vue"), props: true },
  // Settings + setup land in later phases; stubbed so routes resolve.
  { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
  { path: "/setup", name: "setup", component: () => import("./views/SetupView.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/runs" },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});
