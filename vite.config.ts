import { defineConfig } from "vite";

export default defineConfig({
  // 상대 경로로 빌드해 어느 주소(하위 경로 포함)에 올려도 동작하게 함
  base: "./",
});
