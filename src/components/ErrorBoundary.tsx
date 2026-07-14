import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Root-level failure surface for unexpected render/runtime errors.
 *
 * Worker/codec failures already surface through the run status path; this
 * catches the residual case where a component throws and would otherwise
 * white-screen the whole app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("App error boundary caught", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <main className="min-h-dvh bg-background text-foreground">
        <div className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-16 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-sm text-muted-foreground">
            An unexpected error stopped the page. Your local images were not
            uploaded. Try again, or reload if the problem persists.
          </p>
          <p
            data-testid="error-boundary-message"
            className="rounded-md border border-border bg-muted/40 px-3 py-2 text-left text-xs text-muted-foreground"
          >
            {this.state.error.message || String(this.state.error)}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" onClick={this.handleReset} data-testid="error-boundary-retry">
              Try again
            </Button>
            <Button type="button" variant="secondary" onClick={this.handleReload}>
              Reload page
            </Button>
          </div>
        </div>
      </main>
    );
  }
}
