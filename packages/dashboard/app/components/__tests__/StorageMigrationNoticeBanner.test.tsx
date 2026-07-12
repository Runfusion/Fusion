import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STORAGE_MIGRATION_NOTICE_DISMISS_KEY,
  StorageMigrationNoticeBanner,
} from "../StorageMigrationNoticeBanner";

const title = "Storage update coming in the next Fusion version";
const body = /next Fusion version will replace the current SQLite data store with an embedded Postgres backend/i;
const dismissLabel = "Dismiss storage update notice";
const originalLocalStorage = window.localStorage;

describe("StorageMigrationNoticeBanner", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: originalLocalStorage,
    });
    window.localStorage.clear();
  });

  it("renders the storage notice when the dismissal key is absent", () => {
    render(<StorageMigrationNoticeBanner />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: dismissLabel })).toBeInTheDocument();
  });

  it("hides immediately and persists the dismissal key when dismissed", () => {
    render(<StorageMigrationNoticeBanner />);

    fireEvent.click(screen.getByRole("button", { name: dismissLabel }));

    expect(window.localStorage.getItem(STORAGE_MIGRATION_NOTICE_DISMISS_KEY)).toBe("1");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: dismissLabel })).not.toBeInTheDocument();
  });

  it("returns null on a fresh mount when the dismissal key is already persisted", () => {
    window.localStorage.setItem(STORAGE_MIGRATION_NOTICE_DISMISS_KEY, "1");

    render(<StorageMigrationNoticeBanner />);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(title)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: dismissLabel })).not.toBeInTheDocument();
  });

  it("does not crash when localStorage getItem or setItem throws", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error("private mode getItem denied");
        },
        setItem: () => {
          throw new Error("private mode setItem denied");
        },
      },
    });

    expect(() => render(<StorageMigrationNoticeBanner />)).not.toThrow();
    expect(screen.getByRole("status")).toBeInTheDocument();

    expect(() => {
      fireEvent.click(screen.getByRole("button", { name: dismissLabel }));
    }).not.toThrow();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
