import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import App from "@/App";

describe("sanity", () => {
  it("renders the Button (shadcn/ui) with its label", () => {
    render(<Button>Upscale</Button>);
    expect(
      screen.getByRole("button", { name: "Upscale" }),
    ).toBeInTheDocument();
  });

  it("renders the placeholder home page with the app title", async () => {
    render(<App />);
    // `findBy*` flushes the async capability probe (a mount-time state update)
    // before the assertion resolves, so no update escapes the test.
    expect(
      await screen.findByRole("heading", { name: "imageto24", level: 1 }),
    ).toBeInTheDocument();
  });

  it("basic arithmetic holds — Vitest is wired up", () => {
    expect(2 + 2).toBe(4);
  });
});
