/// <reference types="vite/client" />

import type { WeaveApi } from "../shared/types";

declare global {
  interface Window {
    weave: WeaveApi;
  }
}
