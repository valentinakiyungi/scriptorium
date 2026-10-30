#!/usr/bin/env node
// Global entry point (`npm link` / `npx scriptorium`). Registers tsx so the TypeScript sources run directly.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
