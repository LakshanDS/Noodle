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
  { path: "/chats", name: "chats", component: () => import("./views/ChatsView.vue") },
  { path: "/chats/new", name: "chat-new", component: () => import("./views/ChatDetailView.vue"), props: { isNew: true } },
  { path: "/chats/:id", name: "chat-detail", component: () => import("./views/ChatDetailView.vue"), props: true },
  { path: "/runs", name: "runs", component: () => import("./views/RunsView.vue") },
  { path: "/runs/:id", name: "run-detail", component: () => import("./views/RunDetailView.vue"), props: true },
  { path: "/crons", name: "crons", component: () => import("./views/CronsView.vue") },
  { path: "/crons/new", name: "cron-new", component: () => import("./views/CronDetailView.vue"), props: { isNew: true } },
  { path: "/crons/:id", name: "cron-detail", component: () => import("./views/CronDetailView.vue"), props: true },
  { path: "/commands", name: "commands", component: () => import("./views/CommandsView.vue") },
  { path: "/commands/new", name: "command-new", component: () => import("./views/CommandDetailView.vue"), props: { isNew: true } },
  { path: "/commands/:id", name: "command-detail", component: () => import("./views/CommandDetailView.vue"), props: true },
  { path: "/skills", name: "skills", component: () => import("./views/SkillsView.vue") },
  { path: "/skills/new", name: "skill-new", component: () => import("./views/SkillDetailView.vue"), props: { isNew: true } },
  { path: "/skills/:name", name: "skill-detail", component: () => import("./views/SkillDetailView.vue"), props: true },
  { path: "/profiles", name: "profiles", component: () => import("./views/ProfilesView.vue") },
  { path: "/profiles/new", name: "profile-new", component: () => import("./views/ProfileDetailView.vue"), props: { isNew: true } },
  { path: "/profiles/:name", name: "profile-detail", component: () => import("./views/ProfileDetailView.vue"), props: true },
  { path: "/github", name: "github", component: () => import("./views/GitHubBotView.vue") },
  { path: "/logs", name: "logs", component: () => import("./views/LogsView.vue") },
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
