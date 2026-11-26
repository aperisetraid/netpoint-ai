import { parseDemoMode } from './lib/demoMode.ts'

/** Build-time switches, read once from Vite's environment. */
export const demoMode = parseDemoMode(import.meta.env.VITE_DEMO_MODE)
