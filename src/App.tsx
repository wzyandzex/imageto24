import { Button } from "@/components/ui/button";

function App() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-12 px-6 py-16">
      <header className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          imageto24
        </h1>
        <p className="max-w-prose text-balance text-muted-foreground">
          Upscale images to 1080p, 2K, or 4K — faithfully or AI-enhanced —
          entirely in your browser. No uploads, no server, nothing leaves your
          device.
        </p>
      </header>

      <section className="flex flex-col items-center gap-2">
        <Button size="lg">Coming soon</Button>
        <p className="text-sm text-muted-foreground">
          The upscaler is being built. Check back shortly.
        </p>
      </section>
    </main>
  );
}

export default App;
