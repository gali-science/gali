import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "electron/**",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
  use: {
    baseURL: "http://127.0.0.1:5178",
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "VITE_GALI_HTTP=1 VITE_GALI_DEV_AUTH_BYPASS=1 pnpm dev --host 127.0.0.1",
    url: "http://127.0.0.1:5178",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
