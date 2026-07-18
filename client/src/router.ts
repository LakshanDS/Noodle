/**
 * Router — clean URLs (createWebHistory). The server serves the SPA shell at
 * GET / and a catch-all for non-API paths (see ui-routes.ts), so browser history
 * mode works for deep links without hash routing.
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { useAuth } from "./composables/useAuth.js";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/runs" },
  { path: "/login", name: "login", component: () => import("./views/LoginView.vue") },
  { path: "/chats", name: "chats", component: () => import("./views/ChatsView.vue") },
  { path: "/chats/new", name: "chat-new", component: () => import("./views/ChatDetailView.vue"), props: { isNew: true } },
  { path: "/chats/:id", name: "chat-detail", component: () => import("./views/ChatDetailView.vue"), props: true },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/runs/:id", name: "run-detail", component: () => import("./views/RunDetailView.vue"), props: true },
  { path: "/schedulers", name: "schedulers", component: () => import("./views/SchedulersView.vue") },
  { path: "/schedulers/new", name: "scheduler-new", component: () => import("./views/SchedulerDetailView.vue"), props: { isNew: true } },
  { path: "/schedulers/:id", name: "scheduler-detail", component: () => import("./views/SchedulerDetailView.vue"), props: true },
  { path: "/triggers", name: "triggers", component: () => import("./views/TriggersView.vue") },
  { path: "/triggers/new", name: "trigger-new", component: () => import("./views/TriggerDetailView.vue"), props: { isNew: true } },
  { path: "/triggers/:id", name: "trigger-detail", component: () => import("./views/TriggerDetailView.vue"), props: true },
  { path: "/commands", name: "commands", component: () => import("./views/CommandsView.vue") },
  { path: "/commands/new", name: "command-new", component: () => import("./views/CommandDetailView.vue"), props: { isNew: true } },
  { path: "/commands/:id", name: "command-detail", component: () => import("./views/CommandDetailView.vue"), props: true },
  { path: "/skills", name: "skills", component: () => import("./views/SkillsView.vue") },
  { path: "/skills/new", name: "skill-new", component: () => import("./views/SkillDetailView.vue"), props: { isNew: true } },
  { path: "/skills/:name", name: "skill-detail", component: () => import("./views/SkillDetailView.vue"), props: true },
  { path: "/profiles", name: "profiles", component: () => import("./views/ProfilesView.vue") },
  { path: "/profiles/new", name: "profile-new", component: () => import("./views/ProfileDetailView.vue"), props: { isNew: true } },
  { path: "/profiles/:name", name: "profile-detail", component: () => import("./views/ProfileDetailView.vue"), props: true },
  { path: "/github", redirect: "/settings" },
  { path: "/logs", name: "logs", component: () => import("./views/LogsView.vue") },
  { path: "/settings", name: "settings", component: () => import("./views/SettingsView.vue") },
  { path: "/setup", name: "setup", component: () => import("./views/SetupView.vue") },
  { path: "/:pathMatch(.*)*", redirect: "/runs" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 };
  },
});

/**
 * Navigation guard: require login for everything except /login and /setup.
 * Registered here (not in App.vue) so it's active BEFORE the initial
 * navigation resolves — otherwise the first page load bypasses the guard
 * and lands on /runs without a redirect to /login.
 *
 * The guard reads from the shared auth singleton, which probeAuth()
 * (called before mount in main.ts) has already populated.
 */
const PUBLIC_ROUTES = new Set(["login", "setup"]);

router.beforeEach((to) => {
  const { state } = useAuth();
  if (state.known !== true) return true; // still probing — allow through; App.vue guards render
  if (!PUBLIC_ROUTES.has(String(to.name)) && !state.loggedIn) {
    return { name: "login" };
  }
  if (to.name === "login" && state.loggedIn) {
    return { name: "runs" };
  }
  return true;
});
