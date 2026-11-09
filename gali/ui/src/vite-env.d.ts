/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GALI_VERSION?: string;
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string;
  readonly VITE_GALI_DEV_AUTH_BYPASS?: string;
  readonly VITE_GALI_HTTP_URL?: string;
  readonly VITE_GALI_HTTP_TOKEN?: string;
  readonly VITE_GALI_HTTP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
