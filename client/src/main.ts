/**
 * App entry: import the design system, create the Vue app, install the router,
 * probe the auth cookie, then mount. The probe decides the first view (login vs
 * runs) via the navigation guard in App.vue.
 */
import { createApp } from "vue";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/inputs.css";
import App from "./App.vue";
import { router } from "./router.js";
import { probeAuth } from "./composables/useAuth.js";

async function bootstrap(): Promise<void> {
  await probeAuth();
  const app = createApp(App);
  app.use(router);
  await router.isReady();
  app.mount("#app");
}

void bootstrap();
