import { definePlugin } from "@fusion/plugin-sdk";
import { createTodoPluginRoutes } from "./todo-routes.js";
export default definePlugin({ manifest: { id: "fusion-plugin-todos", name: "Todo Lists", version: "0.1.0", description: "Project-scoped Todo Lists" }, state: "installed", hooks: {}, routes: createTodoPluginRoutes(), dashboardViews: [{ viewId: "todos", label: "Todos", componentPath: "./dashboard-view", icon: "CheckSquare", placement: "overflow", order: 70 }] });
export { createTodoPluginRoutes } from "./todo-routes.js";
