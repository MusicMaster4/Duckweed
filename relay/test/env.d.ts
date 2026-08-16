import type { Env as RelayEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends RelayEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends RelayEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}
