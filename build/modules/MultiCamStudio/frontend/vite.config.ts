import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Production and local development use the same ROS process API.
// The development entrypoint starts the backend alongside Vite; this avoids
// maintaining a second camera/recording backend inside Vite configuration.
export default defineConfig({
  plugins: [react()],
  publicDir: "public",
  server: {
    port: Number(process.env.PORT || 5173),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.MCS_API_PORT || 5175}`,
      "/local-api": `http://127.0.0.1:${process.env.MCS_API_PORT || 5175}`,
      "/healthz": `http://127.0.0.1:${process.env.MCS_API_PORT || 5175}`,
    },
  },
});
