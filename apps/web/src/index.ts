/**
 * @vo/web
 *
 * Office canvas: departments, employees, connections, dashboards, approvals.
 */
export const PACKAGE_NAME = "@vo/web" as const;

export { App } from "./app/App.js";
export { ROUTES } from "./app/routes.js";
export { ThemeProvider, useTheme, THEME_STORAGE_KEY } from "./ui/theme.js";
export { Button } from "./ui/button.js";
export { cn } from "./ui/cn.js";
