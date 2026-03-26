// hai board — client
(() => {
  "use strict";

  const COLUMNS = ["triage", "todo", "in-progress", "in-review", "done"];
  const COLUMN_LABELS = {
    triage: "Triage",
    todo: "Todo",
    "in-progress": "In Progress",
    "in-review": "In Review",
    done: "Done",
  };
  const TRANSITIONS = {
    triage: ["todo"],
    todo: ["in-progress", "triage"],
    "in-progress": ["in-review"],
    "in-review": ["done", "in-progress"],
    done: [],
  };

  let tasks = [];
  let eventSource = null;

  // ── API ──
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    return data;
  }

  // ── Render ──
  function render() {
    for (const col of COLUMNS) {
      const body = document.querySelector(`[data-drop="${col}"]`);
      const colTasks = tasks.filter((t) => t.column === col);

      document.querySelector(`[data-count="${col}"]`).textContent =
        colTasks.length;

      if (colTasks.length === 0) {
        body.innerHTML = '<div class="empty-column">No tasks</div>';
      } else {
        body.innerHTML = colTasks.map(cardHTML).join("");
      }
    }

    // Attach drag handlers
    document.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("dragstart", onDragStart);
      card.addEventListener("dragend", onDragEnd);
      card.addEventListener("click", () => showDetail(card.dataset.id));
    });
  }

  function cardHTML(task) {
    const deps =
      task.dependencies && task.dependencies.length
        ? `<div class="card-meta"><span class="card-dep-badge">${task.dependencies.length} dep${task.dependencies.length > 1 ? "s" : ""}</span></div>`
        : "";
    return `<div class="card" data-id="${task.id}" draggable="true">
      <span class="card-id">${task.id}</span>
      <div class="card-title">${escapeHtml(task.title)}</div>
      ${deps}
    </div>`;
  }

  function escapeHtml(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ── Drag & Drop ──
  function onDragStart(e) {
    e.dataTransfer.setData("text/plain", e.currentTarget.dataset.id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("dragging");
  }

  function onDragEnd(e) {
    e.currentTarget.classList.remove("dragging");
    document
      .querySelectorAll(".column")
      .forEach((c) => c.classList.remove("drag-over"));
  }

  function setupDropZones() {
    document.querySelectorAll(".column").forEach((column) => {
      column.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        column.classList.add("drag-over");
      });

      column.addEventListener("dragleave", (e) => {
        // Only remove if actually leaving the column
        if (!column.contains(e.relatedTarget)) {
          column.classList.remove("drag-over");
        }
      });

      column.addEventListener("drop", async (e) => {
        e.preventDefault();
        column.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        const toColumn = column.dataset.column;
        const task = tasks.find((t) => t.id === taskId);

        if (!task || task.column === toColumn) return;

        try {
          await api(`/tasks/${taskId}/move`, {
            method: "POST",
            body: JSON.stringify({ column: toColumn }),
          });
        } catch (err) {
          toast(err.message, "error");
        }
      });
    });
  }

  // ── Task Detail ──
  async function showDetail(id) {
    try {
      const task = await api(`/tasks/${id}`);
      const modal = document.getElementById("detail-modal");

      document.getElementById("detail-id").textContent = task.id;
      document.getElementById("detail-title").textContent = task.title;

      const badge = document.getElementById("detail-column");
      badge.textContent = COLUMN_LABELS[task.column];
      badge.className = `detail-column-badge badge-${task.column}`;

      document.getElementById("detail-meta").textContent =
        `Created ${new Date(task.createdAt).toLocaleDateString()} · ` +
        `Updated ${new Date(task.updatedAt).toLocaleDateString()}`;

      document.getElementById("detail-prompt").textContent =
        task.prompt || "(no prompt)";

      // Dependencies
      const depsEl = document.getElementById("detail-deps");
      if (task.dependencies && task.dependencies.length) {
        depsEl.innerHTML =
          "<h4>Dependencies</h4><ul class='detail-dep-list'>" +
          task.dependencies.map((d) => `<li>${d}</li>`).join("") +
          "</ul>";
      } else {
        depsEl.innerHTML = "";
      }

      // Actions: move buttons for valid transitions + merge for in-review
      const actionsEl = document.getElementById("detail-actions");
      const transitions = TRANSITIONS[task.column] || [];
      const buttons = [
        `<button class="btn btn-danger btn-sm" onclick="window.__deleteTask('${task.id}')">Delete</button>`,
        '<div style="flex:1"></div>',
      ];

      if (task.column === "in-review") {
        buttons.push(
          `<button class="btn btn-sm" onclick="window.__moveTask('${task.id}','in-progress')">Back to In Progress</button>`,
          `<button class="btn btn-primary btn-sm" onclick="window.__mergeTask('${task.id}')">Merge & Close</button>`,
        );
      } else {
        transitions.forEach((col) => {
          buttons.push(
            `<button class="btn btn-sm" onclick="window.__moveTask('${task.id}','${col}')">Move to ${COLUMN_LABELS[col]}</button>`,
          );
        });
      }

      actionsEl.innerHTML = buttons.join("");

      openModal("detail-modal");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // Global action handlers (used by onclick in dynamic HTML)
  window.__moveTask = async (id, column) => {
    try {
      await api(`/tasks/${id}/move`, {
        method: "POST",
        body: JSON.stringify({ column }),
      });
      closeModal("detail-modal");
      toast(`Moved to ${COLUMN_LABELS[column]}`, "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.__mergeTask = async (id) => {
    if (!confirm(`Merge ${id} into the current branch?`)) return;
    try {
      const result = await api(`/tasks/${id}/merge`, { method: "POST" });
      closeModal("detail-modal");
      const msg = result.merged
        ? `Merged ${id} (branch: ${result.branch})`
        : `Closed ${id} (${result.error || "no branch to merge"})`;
      toast(msg, "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  window.__deleteTask = async (id) => {
    if (!confirm(`Delete ${id}?`)) return;
    try {
      await api(`/tasks/${id}`, { method: "DELETE" });
      closeModal("detail-modal");
      toast(`Deleted ${id}`, "info");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  // ── Create Task ──
  function setupCreateForm() {
    const form = document.getElementById("create-form");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const title = document.getElementById("task-title").value.trim();
      const description = document.getElementById("task-desc").value.trim();
      const depsRaw = document.getElementById("task-deps").value.trim();
      const dependencies = depsRaw
        ? depsRaw.split(",").map((s) => s.trim()).filter(Boolean)
        : [];

      if (!title) return;

      try {
        const task = await api("/tasks", {
          method: "POST",
          body: JSON.stringify({ title, description, dependencies }),
        });
        closeModal("create-modal");
        form.reset();
        toast(`Created ${task.id}`, "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  // ── SSE ──
  function connectSSE() {
    eventSource = new EventSource("/api/events");

    eventSource.addEventListener("task:created", (e) => {
      const task = JSON.parse(e.data);
      tasks.push(task);
      render();
    });

    eventSource.addEventListener("task:moved", (e) => {
      const { task } = JSON.parse(e.data);
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) tasks[idx] = task;
      render();
    });

    eventSource.addEventListener("task:updated", (e) => {
      const task = JSON.parse(e.data);
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) tasks[idx] = task;
      render();
    });

    eventSource.addEventListener("task:deleted", (e) => {
      const task = JSON.parse(e.data);
      tasks = tasks.filter((t) => t.id !== task.id);
      render();
    });

    eventSource.addEventListener("task:merged", (e) => {
      const { task } = JSON.parse(e.data);
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) tasks[idx] = task;
      render();
    });

    eventSource.addEventListener("error", () => {
      setTimeout(() => {
        if (eventSource.readyState === EventSource.CLOSED) connectSSE();
      }, 3000);
    });
  }

  // ── Modals ──
  function openModal(id) {
    document.getElementById(id).classList.add("open");
  }

  function closeModal(id) {
    document.getElementById(id).classList.remove("open");
  }

  function setupModals() {
    // Close buttons
    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });

    // Click overlay to close
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.remove("open");
      });
    });

    // Escape key
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-overlay.open").forEach((m) => {
          m.classList.remove("open");
        });
      }
    });

    // Add task button
    document.getElementById("add-task-btn").addEventListener("click", () => {
      openModal("create-modal");
      setTimeout(() => document.getElementById("task-title").focus(), 100);
    });
  }

  // ── Toasts ──
  function toast(message, type = "info") {
    const container = document.getElementById("toasts");
    const el = document.createElement("div");
    el.className = `toast toast-${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ── Init ──
  async function init() {
    try {
      tasks = await api("/tasks");
    } catch {
      tasks = [];
    }
    render();
    setupDropZones();
    setupModals();
    setupCreateForm();
    connectSSE();
  }

  init();
})();
