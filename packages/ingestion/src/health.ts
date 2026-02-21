import { writeFileSync } from "node:fs";

export function touchHealthcheck(): void {
  writeFileSync("/tmp/healthcheck", String(Math.floor(Date.now() / 1000)));
}
