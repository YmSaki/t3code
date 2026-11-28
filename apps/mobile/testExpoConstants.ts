import { vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
