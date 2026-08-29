export function useConfirm() {
  return {
    confirm: async (input: string | { title?: string; message?: string; danger?: boolean }): Promise<boolean> => {
      const message = typeof input === "string" ? input : [input.title, input.message].filter(Boolean).join("\n\n");
      return window.confirm(message || "Are you sure?");
    },
  };
}
