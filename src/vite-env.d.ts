/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The online server's address (e.g. http://localhost:8787). Without it: the stand-in (dev) or "coming soon". */
  readonly VITE_CUBE6_SERVER?: string;
}
