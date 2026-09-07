/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STATION_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
